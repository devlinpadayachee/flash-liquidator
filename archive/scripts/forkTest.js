/**
 * Fork test: end-to-end FlashLiquidatorV2 liquidation on a Polygon fork.
 *
 * Creates a REAL Aave V3 position (supply WPOL, borrow USDC at max LTV),
 * time-travels until interest pushes HF < 1, then liquidates it through the
 * new contract using a Uniswap V3 swap route and asserts actual profit.
 *
 * Run: FORK_POLYGON=true npx hardhat run scripts/forkTest.js
 */
const { ethers, network } = require("hardhat");

const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // native USDC
const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // bridged USDC.e
const QUICKSWAP_V2 = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const UNIV3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const UNIV3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

const POOL_ABI = [
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
];
const WETH_ABI = ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
const QUOTER_ABI = [
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
];

async function main() {
  const [borrower, liquidatorOwner] = await ethers.getSigners();
  console.log("fork block:", await ethers.provider.getBlockNumber());

  // ---- 1. Create a real Aave position ----
  const wpol = new ethers.Contract(WPOL, WETH_ABI, borrower);
  const pool = new ethers.Contract(AAVE_POOL, POOL_ABI, borrower);

  const supplyAmount = ethers.parseEther("5000"); // 5000 WPOL
  await (await wpol.deposit({ value: supplyAmount })).wait();
  await (await wpol.approve(AAVE_POOL, supplyAmount)).wait();
  await (await pool.supply(WPOL, supplyAmount, borrower.address, 0)).wait();
  console.log("supplied 5000 WPOL");

  let acct = await pool.getUserAccountData(borrower.address);
  // availableBorrowsBase has 8 decimals USD; USDC has 6 -> divide by 100
  const borrowAmount = (acct.availableBorrowsBase * 99n) / 100n / 100n;
  await (await pool.borrow(USDC, borrowAmount, 2, 0, borrower.address)).wait();
  console.log(`borrowed ${ethers.formatUnits(borrowAmount, 6)} USDC`);

  // ---- 2. Time-travel until HF < 1 ----
  let hf;
  for (let years = 0; years < 12; years++) {
    acct = await pool.getUserAccountData(borrower.address);
    hf = Number(ethers.formatEther(acct.healthFactor));
    console.log(`HF after ${years}y: ${hf.toFixed(4)}`);
    if (hf < 1) break;
    await network.provider.send("evm_increaseTime", [365 * 24 * 3600]);
    await network.provider.send("evm_mine");
  }
  if (hf >= 1) throw new Error("could not push HF below 1");

  // ---- 3. Deploy FlashLiquidatorV2 ----
  const Factory = await ethers.getContractFactory("FlashLiquidatorV2", liquidatorOwner);
  const liq = await Factory.deploy(AAVE_POOL, QUICKSWAP_V2, WPOL);
  await liq.waitForDeployment();
  const liqAddr = await liq.getAddress();
  console.log("FlashLiquidatorV2 deployed:", liqAddr);

  // ---- 4. Quote V3 routes for the collateral we expect to seize ----
  // Aave v3.4 dust rule (MustNotLeaveDust): small positions must be
  // liquidated 100%, not 50%. Flash-borrow full debt + 0.1% buffer;
  // liquidationCall caps to actual debt, leftovers repay the flash loan.
  const debtToCover = ((acct.totalDebtBase / 100n) * 1001n) / 1000n;
  // WPOL price from collateral: totalCollateralBase(8dec USD) / 5000 WPOL
  const polPriceUSD = Number(acct.totalCollateralBase) / 1e8 / 5000;
  const debtUSD = Number(debtToCover) / 1e6;
  const expectColl = ethers.parseEther(((debtUSD * 1.08) / polPriceUSD).toFixed(18)); // ~8% bonus headroom

  const quoter = new ethers.Contract(UNIV3_QUOTER_V2, QUOTER_ABI, borrower);
  const candidates = [
    { name: "WPOL-500-USDC", path: ethers.solidityPacked(["address", "uint24", "address"], [WPOL, 500, USDC]) },
    { name: "WPOL-3000-USDC", path: ethers.solidityPacked(["address", "uint24", "address"], [WPOL, 3000, USDC]) },
    { name: "WPOL-500-USDCe-100-USDC", path: ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [WPOL, 500, USDCE, 100, USDC]) },
  ];
  let best = null;
  for (const c of candidates) {
    try {
      const [out] = await quoter.quoteExactInput.staticCall(c.path, expectColl);
      console.log(`quote ${c.name}: ${ethers.formatUnits(out, 6)} USDC`);
      if (!best || out > best.out) best = { ...c, out };
    } catch (e) {
      console.log(`quote ${c.name}: no route (${String(e.message).slice(0, 60)})`);
    }
  }
  if (!best) throw new Error("no V3 route found");
  // Rate-based floor: min USDC out per 1e18 WPOL in, -1% slippage
  const minOutRate = (((best.out * 99n) / 100n) * 10n ** 18n) / expectColl;

  // ---- 5. Liquidate via V3 route ----
  const params = {
    protocolType: 0,
    swapMode: 1,
    protocol: AAVE_POOL,
    borrower: borrower.address,
    debtToken: USDC,
    collateralToken: WPOL,
    debtAmount: debtToCover,
    swapRouter: UNIV3_ROUTER,
    swapPath: best.path,
    minOutRate,
    minProfit: 1n,
  };

  const gasEst = await liq.connect(liquidatorOwner).liquidate.estimateGas(params);
  console.log("estimateGas:", gasEst.toString());

  const tx = await liq.connect(liquidatorOwner).liquidate(params, { gasLimit: (gasEst * 130n) / 100n });
  const receipt = await tx.wait();
  console.log("liquidation tx status:", receipt.status, "gasUsed:", receipt.gasUsed.toString());

  const usdc = new ethers.Contract(USDC, ERC20_ABI, borrower);
  const profit = await usdc.balanceOf(liqAddr);
  console.log(`PROFIT in contract: ${ethers.formatUnits(profit, 6)} USDC (debt covered: ${ethers.formatUnits(debtToCover, 6)})`);

  acct = await pool.getUserAccountData(borrower.address);
  console.log("borrower HF after liquidation:", Number(ethers.formatEther(acct.healthFactor)).toFixed(4));

  // ---- 6. Withdraw profit to owner ----
  await (await liq.connect(liquidatorOwner).withdrawToken(USDC, 0)).wait();
  const ownerBal = await usdc.balanceOf(liquidatorOwner.address);
  console.log(`owner USDC after withdraw: ${ethers.formatUnits(ownerBal, 6)}`);

  if (profit <= 0n) throw new Error("NO PROFIT - test failed");
  console.log("FORK_TEST_OK");
}

main().catch((e) => {
  console.error("FORK TEST FAILED:", e.message);
  process.exit(1);
});
