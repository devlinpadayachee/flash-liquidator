/**
 * Direct ethers deploy of FlashLiquidatorV2 (no hardhat runtime).
 * Uses the compiled artifact + the same RPC the bot uses.
 *
 * Run: node scripts/deployV2Direct.js
 */
require('dotenv').config();
const { ethers } = require('ethers');
const artifact = require('../artifacts/contracts/FlashLiquidatorV2.sol/FlashLiquidatorV2.json');

const CFG = {
  aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  defaultRouter: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff', // QuickSwap V2
  wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WPOL
};

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL, 137, { staticNetwork: true });
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log('deployer:', wallet.address);

  const bal = await provider.getBalance(wallet.address);
  console.log('balance:', ethers.formatEther(bal), 'POL');
  const nonce = await provider.getTransactionCount(wallet.address);
  console.log('nonce:', nonce);

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const deployTx = await factory.getDeployTransaction(CFG.aavePool, CFG.defaultRouter, CFG.wrappedNative);

  const feeData = await provider.getFeeData();
  const gasEstimate = await provider.estimateGas({ ...deployTx, from: wallet.address });
  console.log('estimated gas:', gasEstimate.toString());
  console.log('gas price (gwei):', ethers.formatUnits(feeData.gasPrice || 0n, 'gwei'));

  console.log('deploying...');
  const contract = await factory.deploy(CFG.aavePool, CFG.defaultRouter, CFG.wrappedNative, {
    gasLimit: (gasEstimate * 130n) / 100n,
  });
  const tx = contract.deploymentTransaction();
  console.log('deploy tx hash:', tx.hash);
  console.log('waiting for confirmation...');

  const receipt = await tx.wait(2); // wait 2 confirmations
  const addr = await contract.getAddress();
  console.log('DEPLOYED:', addr);
  console.log('block:', receipt.blockNumber, 'gasUsed:', receipt.gasUsed.toString(), 'status:', receipt.status);

  // Verify owner on-chain
  const c = new ethers.Contract(addr, artifact.abi, provider);
  const owner = await c.owner();
  console.log('on-chain owner:', owner);
  console.log('owner == deployer:', owner.toLowerCase() === wallet.address.toLowerCase());
  console.log('\nDEPLOY_OK ADDRESS=' + addr);
})().catch((e) => { console.error('DEPLOY FAILED:', e.message); process.exit(1); });
