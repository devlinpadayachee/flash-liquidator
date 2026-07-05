/**
 * Deploy FlashLiquidatorV2.
 *
 * Run: npx hardhat run scripts/deployV2.js --network polygon
 */
const { ethers, network } = require("hardhat");

// Per-network constructor args: Aave V3 pool, default V2 router, wrapped native
const DEPLOY_CONFIG = {
  polygon: {
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    defaultRouter: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", // QuickSwap V2
    wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WPOL
  },
  arbitrum: {
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    defaultRouter: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", // SushiSwap
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
  },
  base: {
    aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    defaultRouter: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", // BaseSwap
    wrappedNative: "0x4200000000000000000000000000000000000006", // WETH
  },
};

async function main() {
  const cfg = DEPLOY_CONFIG[network.name];
  if (!cfg) throw new Error(`No deploy config for network '${network.name}'`);

  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`network: ${network.name}`);
  console.log(`deployer: ${deployer.address} (balance: ${ethers.formatEther(bal)})`);

  const Factory = await ethers.getContractFactory("FlashLiquidatorV2");
  const contract = await Factory.deploy(cfg.aavePool, cfg.defaultRouter, cfg.wrappedNative);
  console.log(`deploy tx: ${contract.deploymentTransaction().hash}`);

  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  const receipt = await contract.deploymentTransaction().wait();

  console.log(`FlashLiquidatorV2 deployed: ${addr}`);
  console.log(`gas used: ${receipt.gasUsed.toString()}`);
  console.log(`owner: ${await contract.owner()}`);
  console.log(`\nSet in .env: ${network.name.toUpperCase()}_CONTRACT_ADDRESS=${addr}`);
}

main().catch((e) => {
  console.error("DEPLOY FAILED:", e.message);
  process.exit(1);
});
