/**
 * Deploy FlashLiquidator Contract
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network polygon
 *   npx hardhat run scripts/deploy.js --network arbitrum
 *   npx hardhat run scripts/deploy.js --network base
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Chain-specific deployment configs
const DEPLOYMENT_CONFIG = {
  polygon: {
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    swapRouter: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", // QuickSwap
    wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
    envKey: "POLYGON_CONTRACT_ADDRESS",
  },
  arbitrum: {
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    swapRouter: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", // SushiSwap
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
    envKey: "ARBITRUM_CONTRACT_ADDRESS",
  },
  base: {
    aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    swapRouter: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86", // BaseSwap
    wrappedNative: "0x4200000000000000000000000000000000000006", // WETH
    envKey: "BASE_CONTRACT_ADDRESS",
  },
  bsc: {
    // BSC doesn't have Aave V3, uses Venus + PancakeSwap flash swaps
    aavePool: "0x0000000000000000000000000000000000000000", // Placeholder
    swapRouter: "0x10ED43C718714eb63d5aA57B78B54704E256024E", // PancakeSwap
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    envKey: "BSC_CONTRACT_ADDRESS",
  },
  avalanche: {
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    swapRouter: "0x60aE616a2155Ee3d9A68541Ba4544862310933d4", // Trader Joe
    wrappedNative: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", // WAVAX
    envKey: "AVALANCHE_CONTRACT_ADDRESS",
  },
};

async function main() {
  const network = hre.network.name;
  console.log(`\n⚡ Deploying FlashLiquidator to ${network}...\n`);

  // Get deployment config
  const config = DEPLOYMENT_CONFIG[network];
  if (!config) {
    console.error(`❌ No deployment config for network: ${network}`);
    console.log(`   Supported: ${Object.keys(DEPLOYMENT_CONFIG).join(", ")}`);
    process.exit(1);
  }

  // Get deployer
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log(`📝 Deployer: ${deployer.address}`);
  console.log(`💰 Balance: ${hre.ethers.formatEther(balance)} ${network === 'bsc' ? 'BNB' : network === 'polygon' ? 'POL' : 'ETH'}`);
  console.log("");

  // Check balance
  if (balance < hre.ethers.parseEther("0.01")) {
    console.error("❌ Insufficient balance for deployment");
    process.exit(1);
  }

  // Log deployment params
  console.log("📋 Deployment Parameters:");
  console.log(`   Aave Pool: ${config.aavePool}`);
  console.log(`   Swap Router: ${config.swapRouter}`);
  console.log(`   Wrapped Native: ${config.wrappedNative}`);
  console.log("");

  // Deploy contract
  console.log("🚀 Deploying contract...");

  const FlashLiquidator = await hre.ethers.getContractFactory("FlashLiquidator");
  const flashLiquidator = await FlashLiquidator.deploy(
    config.aavePool,
    config.swapRouter,
    config.wrappedNative
  );

  await flashLiquidator.waitForDeployment();
  const contractAddress = await flashLiquidator.getAddress();

  console.log(`\n✅ FlashLiquidator deployed to: ${contractAddress}`);

  // Update .env file
  const envPath = path.join(__dirname, "..", ".env");
  const envKey = config.envKey;

  try {
    let envContent = "";
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, "utf8");
    }

    // Update or add the contract address
    const regex = new RegExp(`^${envKey}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${envKey}=${contractAddress}`);
    } else {
      envContent += `\n${envKey}=${contractAddress}`;
    }

    fs.writeFileSync(envPath, envContent.trim() + "\n");
    console.log(`\n📝 Updated .env with ${envKey}=${contractAddress}`);
  } catch (err) {
    console.log(`\n⚠️ Could not update .env automatically.`);
    console.log(`   Please add this to your .env:`);
    console.log(`   ${envKey}=${contractAddress}`);
  }

  // Verify contract (optional)
  if (process.env.VERIFY === "true") {
    console.log("\n🔍 Verifying contract on explorer...");
    try {
      await hre.run("verify:verify", {
        address: contractAddress,
        constructorArguments: [
          config.aavePool,
          config.swapRouter,
          config.wrappedNative,
        ],
      });
      console.log("✅ Contract verified!");
    } catch (error) {
      console.log(`⚠️ Verification failed: ${error.message}`);
    }
  }

  // Summary
  console.log("\n" + "═".repeat(60));
  console.log("  ✅ DEPLOYMENT COMPLETE!");
  console.log("═".repeat(60));
  console.log(`\n  Contract: ${contractAddress}`);
  console.log(`  Network:  ${network}`);
  console.log(`  Owner:    ${deployer.address}`);
  console.log("\n  Next steps:");
  console.log(`  1. Make sure ${envKey}=${contractAddress} is in your .env`);
  console.log(`  2. Run the bot: CHAIN=${network.toUpperCase()} node src/index.js`);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

