/**
 * Check actual Aave V3 liquidations on Polygon in the last 24 hours
 * This tells us if we're missing opportunities or if there simply aren't any
 */

require('dotenv').config();
const { ethers } = require('ethers');

const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
const LIQUIDATION_EVENT = 'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)';

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL || process.env.POLYGON_PROVIDER_URL);

  console.log('\n🔍 Checking ACTUAL Aave V3 liquidations on Polygon...\n');

  const currentBlock = await provider.getBlockNumber();
  const blocksPerDay = Math.floor(86400 / 2); // ~2 sec block time on Polygon
  const days = parseInt(process.env.DAYS || '5'); // Check last N days
  const fromBlock = currentBlock - (blocksPerDay * days);

  console.log(`📅 Checking last ${days} days...`);

  console.log(`📊 Scanning blocks ${fromBlock} to ${currentBlock} (last ~24 hours)`);

  const pool = new ethers.Contract(AAVE_POOL, [LIQUIDATION_EVENT], provider);

  // Query in chunks to avoid RPC limits
  const chunkSize = 10000;
  let totalLiquidations = 0;
  let totalDebtLiquidated = 0n;
  const liquidators = new Map();
  const liquidatedUsers = [];

  for (let start = fromBlock; start < currentBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, currentBlock);

    try {
      const events = await pool.queryFilter('LiquidationCall', start, end);

      for (const event of events) {
        totalLiquidations++;
        totalDebtLiquidated += event.args.debtToCover;

        const liquidator = event.args.liquidator.toLowerCase();
        liquidators.set(liquidator, (liquidators.get(liquidator) || 0) + 1);

        liquidatedUsers.push({
          user: event.args.user,
          debt: parseFloat(ethers.formatUnits(event.args.debtToCover, 8)),
          liquidator: event.args.liquidator,
          block: event.blockNumber,
        });
      }

      process.stdout.write(`   Scanned to block ${end}...\r`);
    } catch (e) {
      console.log(`   ⚠️ Error at block ${start}: ${e.message}`);
    }
  }

  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  📊 POLYGON AAVE V3 LIQUIDATIONS - LAST 24 HOURS');
  console.log('═══════════════════════════════════════════════════════════');

  if (totalLiquidations === 0) {
    console.log('\n  ❌ ZERO LIQUIDATIONS in the last 24 hours!');
    console.log('\n  This means:');
    console.log('  • The market has been STABLE');
    console.log('  • No positions dropped below HF 1.0');
    console.log('  • Your bot is working correctly - there\'s just nothing to liquidate');
    console.log('\n  💡 This is NORMAL during stable market conditions.');
    console.log('     Liquidations happen during crashes/volatility.\n');
  } else {
    console.log(`\n  Total Liquidations: ${totalLiquidations}`);
    console.log(`  Total Debt Liquidated: $${parseFloat(ethers.formatUnits(totalDebtLiquidated, 8)).toFixed(2)}`);

    console.log('\n  📋 LIQUIDATORS (who got there first):');
    const sortedLiquidators = [...liquidators.entries()].sort((a, b) => b[1] - a[1]);
    for (const [addr, count] of sortedLiquidators.slice(0, 10)) {
      const pct = ((count / totalLiquidations) * 100).toFixed(1);
      console.log(`     ${addr.slice(0, 10)}... : ${count} liquidations (${pct}%)`);
    }

    console.log('\n  📋 RECENT LIQUIDATIONS:');
    for (const liq of liquidatedUsers.slice(-10)) {
      console.log(`     User: ${liq.user.slice(0, 10)}... | Debt: $${liq.debt.toFixed(2)} | Block: ${liq.block}`);
    }

    // Check if any were positions we were tracking
    console.log('\n  ⚠️ IMPORTANT: If liquidations happened and you didn\'t get them,');
    console.log('     professional MEV bots with private mempool access beat you.');
    console.log('     They have ~100ms advantage and specialized infrastructure.\n');
  }

  console.log('═══════════════════════════════════════════════════════════\n');
}

main().catch(console.error);

