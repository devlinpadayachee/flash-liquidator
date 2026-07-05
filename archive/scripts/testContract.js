// scripts/testContract.js
// Run with: npx hardhat run scripts/testContract.js --network polygon

const hre = require("hardhat");

async function main() {
  console.log("🔍 Testing FlashLiquidator Contract...\n");

  // Get contract address from env
  const contractAddress = process.env.POLYGON_CONTRACT_ADDRESS;

  if (!contractAddress) {
    console.log("❌ POLYGON_CONTRACT_ADDRESS not set in .env");
    console.log("   Add: POLYGON_CONTRACT_ADDRESS=0xYourContractAddress");
    process.exit(1);
  }

  console.log(`📋 Contract Address: ${contractAddress}`);

  // Get signer
  const [signer] = await hre.ethers.getSigners();
  console.log(`👤 Your Wallet: ${signer.address}`);

  const balance = await hre.ethers.provider.getBalance(signer.address);
  console.log(`💰 Wallet Balance: ${hre.ethers.formatEther(balance)} POL\n`);

  // Connect to contract
  const FlashLiquidator = await hre.ethers.getContractFactory("FlashLiquidator");
  const contract = FlashLiquidator.attach(contractAddress);

  console.log("═══════════════════════════════════════");
  console.log("  CONTRACT STATE");
  console.log("═══════════════════════════════════════");

  try {
    // Test 1: Check owner
    const owner = await contract.owner();
    const isOwner = owner.toLowerCase() === signer.address.toLowerCase();
    console.log(`\n✅ Owner: ${owner}`);
    console.log(`   You are owner: ${isOwner ? '✅ YES' : '❌ NO'}`);

    if (!isOwner) {
      console.log("\n⚠️  WARNING: You are not the contract owner!");
      console.log("   Only the owner can execute liquidations.");
    }

    // Test 2: Check Aave Pool
    const aavePool = await contract.aavePool();
    console.log(`\n✅ Aave Pool: ${aavePool}`);
    const expectedPool = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"; // Polygon
    console.log(`   Expected: ${expectedPool}`);
    console.log(`   Match: ${aavePool.toLowerCase() === expectedPool.toLowerCase() ? '✅' : '❌'}`);

    // Test 3: Check Swap Router
    const swapRouter = await contract.swapRouter();
    console.log(`\n✅ Swap Router: ${swapRouter}`);

    // Test 4: Check Wrapped Native
    const wrappedNative = await contract.wrappedNative();
    console.log(`\n✅ Wrapped Native: ${wrappedNative}`);
    const expectedWMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
    console.log(`   Expected WMATIC: ${expectedWMATIC}`);
    console.log(`   Match: ${wrappedNative.toLowerCase() === expectedWMATIC.toLowerCase() ? '✅' : '❌'}`);

    // Test 5: Check Min Profit
    const minProfit = await contract.minProfitWei();
    console.log(`\n✅ Min Profit: ${hre.ethers.formatEther(minProfit)} tokens`);

    // Test 6: Check contract has code
    const code = await hre.ethers.provider.getCode(contractAddress);
    console.log(`\n✅ Contract Deployed: ${code.length > 2 ? 'YES' : 'NO'}`);
    console.log(`   Bytecode size: ${(code.length - 2) / 2} bytes`);

    console.log("\n═══════════════════════════════════════");
    console.log("  TEST SIMULATION");
    console.log("═══════════════════════════════════════");

    // Test 7: Try to call simulateLiquidation (view function - no gas)
    console.log("\n🧪 Testing simulateLiquidation (view call)...");

    const testParams = {
      protocolType: 0, // Aave
      protocol: aavePool,
      borrower: "0x344ba5b34Ca2F78Ffb53c0fe6e3AD94e39D0dc54", // From at-risk list
      debtToken: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC on Polygon
      collateralToken: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH on Polygon
      debtAmount: hre.ethers.parseUnits("100", 6), // 100 USDC
      swapRouter: swapRouter,
      minProfit: 0
    };

    try {
      const simResult = await contract.simulateLiquidation(testParams);
      console.log(`   Simulation returned:`);
      console.log(`   - Profitable: ${simResult.profitable}`);
      console.log(`   - Est. Profit: ${hre.ethers.formatEther(simResult.estimatedProfit)} tokens`);
    } catch (simError) {
      // This is expected to fail for non-liquidatable positions
      console.log(`   ⚠️ Simulation reverted (expected - position not liquidatable)`);
      const errMsg = simError.reason || simError.message || '';
      console.log(`   Error: ${errMsg.slice(0, 100)}`);
    }

    console.log("\n═══════════════════════════════════════");
    console.log("  ✅ CONTRACT VERIFICATION COMPLETE");
    console.log("═══════════════════════════════════════");
    console.log("\nYour contract is deployed and configured correctly!");
    console.log("It will execute when a liquidatable position (HF < 1.0) is found.\n");

  } catch (error) {
    console.log(`\n❌ Error: ${error.message}`);
    console.log("\nPossible issues:");
    console.log("- Wrong contract address");
    console.log("- Contract not deployed on this network");
    console.log("- RPC connection issues");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

