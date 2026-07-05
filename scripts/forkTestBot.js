/**
 * Fork test #2: drive the REAL JS executor (src/executors/liquidator.js)
 * against a Polygon fork - validates ABI encoding, route quoting, dust-rule
 * sizing and profit accounting exactly as the live bot will run them.
 *
 * Run: FORK_POLYGON=true npx hardhat run scripts/forkTestBot.js
 */
const { ethers, network } = require("hardhat");
const { getChain } = require("../src/config/chains");
const Liquidator = require("../src/executors/liquidator");

const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

const POOL_ABI = [
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
];
const WETH_ABI = ["function deposit() payable", "function approve(address,uint256) returns (bool)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const [borrower, owner] = await ethers.getSigners();

  // ---- underwater position (same recipe as forkTest.js) ----
  const wpol = new ethers.Contract(WPOL, WETH_ABI, borrower);
  const pool = new ethers.Contract(AAVE_POOL, POOL_ABI, borrower);
  const supplyAmount = ethers.parseEther("5000");
  await (await wpol.deposit({ value: supplyAmount })).wait();
  await (await wpol.approve(AAVE_POOL, supplyAmount)).wait();
  await (await pool.supply(WPOL, supplyAmount, borrower.address, 0)).wait();
  let acct = await pool.getUserAccountData(borrower.address);
  const borrowAmount = (acct.availableBorrowsBase * 99n) / 100n / 100n;
  await (await pool.borrow(USDC, borrowAmount, 2, 0, borrower.address)).wait();

  let hf;
  for (let y = 0; y < 12; y++) {
    acct = await pool.getUserAccountData(borrower.address);
    hf = Number(ethers.formatEther(acct.healthFactor));
    if (hf < 1) break;
    await network.provider.send("evm_increaseTime", [365 * 24 * 3600]);
    await network.provider.send("evm_mine");
  }
  if (hf >= 1) throw new Error("could not push HF below 1");
  console.log(`position underwater: HF ${hf.toFixed(4)}, debt $${(Number(acct.totalDebtBase) / 1e8).toFixed(2)}`);

  // ---- deploy V2 contract ----
  const Factory = await ethers.getContractFactory("FlashLiquidatorV2", owner);
  const liqContract = await Factory.deploy(AAVE_POOL, "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", WPOL);
  await liqContract.waitForDeployment();
  const liqAddr = await liqContract.getAddress();
  console.log("contract:", liqAddr);

  // ---- drive the REAL executor ----
  const chain = getChain("POLYGON");
  const liquidator = new Liquidator(chain, ethers.provider, owner, {
    minProfitUSD: 0.3,
    maxGasUSD: 5,
    dryRun: false,
  });
  await liquidator.initialize(liqAddr);

  const position = {
    address: borrower.address,
    protocol: "AAVE_V3",
    healthFactor: hf,
    totalDebtUSD: Number(acct.totalDebtBase) / 1e8,
  };

  const result = await liquidator.liquidate(position, null);
  console.log("executor result:", JSON.stringify({ success: result.success, profit: result.profit, reason: result.reason }));

  const usdc = new ethers.Contract(USDC, ERC20_ABI, ethers.provider);
  const contractBal = await usdc.balanceOf(liqAddr);
  console.log(`USDC in contract: ${ethers.formatUnits(contractBal, 6)}`);

  if (!result.success || contractBal <= 0n) throw new Error("executor failed to liquidate");
  console.log("FORK_BOT_TEST_OK");
}

main().catch((e) => {
  console.error("FORK BOT TEST FAILED:", e.message);
  process.exit(1);
});
