/**
 * Console UI Utilities
 *
 * Beautiful console output for the liquidation bot
 */

const chalk = require('chalk');
const Table = require('cli-table3');
const boxen = require('boxen');

// Theme colors
const theme = {
  primary: chalk.hex('#00D9FF'),     // Cyan
  secondary: chalk.hex('#FF6B6B'),   // Red
  success: chalk.hex('#4ADE80'),     // Green
  warning: chalk.hex('#FBBF24'),     // Yellow
  error: chalk.hex('#EF4444'),       // Red
  muted: chalk.hex('#6B7280'),       // Gray
  accent: chalk.hex('#A78BFA'),      // Purple
  profit: chalk.hex('#10B981'),      // Emerald
  loss: chalk.hex('#F87171'),        // Red
};

// Icons
const icons = {
  bolt: '⚡',
  check: '✅',
  cross: '❌',
  warning: '⚠️',
  money: '💰',
  chart: '📊',
  eye: '👁️',
  target: '🎯',
  rocket: '🚀',
  clock: '⏰',
  fire: '🔥',
  skull: '💀',
  heart: '❤️',
  shield: '🛡️',
};

/**
 * Print startup banner
 */
function printBanner(chainName) {
  const banner = `
  ███████╗██╗      █████╗ ███████╗██╗  ██╗
  ██╔════╝██║     ██╔══██╗██╔════╝██║  ██║
  █████╗  ██║     ███████║███████╗███████║
  ██╔══╝  ██║     ██╔══██╗╚════██║██╔══██║
  ██║     ███████╗██║  ██║███████║██║  ██║
  ╚═╝     ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
  ██╗     ██╗ ██████╗ ██╗   ██╗██╗██████╗  █████╗ ████████╗ ██████╗ ██████╗
  ██║     ██║██╔═══██╗██║   ██║██║██╔══██╗██╔══██╗╚══██╔══╝██╔═══██╗██╔══██╗
  ██║     ██║██║   ██║██║   ██║██║██║  ██║███████║   ██║   ██║   ██║██████╔╝
  ██║     ██║██║▄▄ ██║██║   ██║██║██║  ██║██╔══██║   ██║   ██║   ██║██╔══██╗
  ███████╗██║╚██████╔╝╚██████╔╝██║██████╔╝██║  ██║   ██║   ╚██████╔╝██║  ██║
  ╚══════╝╚═╝ ╚══▀▀═╝  ╚═════╝ ╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝
`;

  console.log(theme.primary(banner));
  console.log(boxen(
    theme.accent(`  ${icons.bolt} Zero-Capital Flash Loan Liquidation Bot ${icons.bolt}  `),
    {
      padding: 1,
      margin: 1,
      borderStyle: 'double',
      borderColor: 'cyan',
    }
  ));
  console.log(theme.muted(`  Chain: ${theme.primary(chainName)} | v1.0.0\n`));
}

/**
 * Print status update
 */
function printStatus(monitorStats, liquidatorStats, chain) {
  console.log('\n' + theme.primary('═'.repeat(60)));
  console.log(`  ${icons.chart} ${theme.primary.bold('STATUS UPDATE')} - ${chain}`);
  console.log(theme.primary('─'.repeat(60)));

  const table = new Table({
    chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
    style: { head: [], border: [] },
  });

  // Build monitoring mode string
  let monitoringMode = [];
  if (monitorStats.hasWebSocket) monitoringMode.push('WSS');
  if (monitorStats.hasMempool) monitoringMode.push('MEMPOOL');
  if (monitorStats.usingSubgraph) monitoringMode.push('SUBGRAPH');
  const modeStr = monitoringMode.length > 0
    ? theme.success(monitoringMode.join(' + '))
    : theme.warning('POLLING');

  // Mempool stats
  const mempoolUpdates = monitorStats.mempoolStats?.oracleUpdatesDetected || 0;
  const mempoolWatched = monitorStats.mempoolStats?.oracleAddressesWatched || 0;

  // RPC stats
  const rpcStats = monitorStats.rpcStats || {};
  const rpcTotal = rpcStats.totalCalls || 0;
  const rpcPerMin = rpcStats.callsPerMinute || 0;
  const multicallBatches = rpcStats.multicallBatches || 0;

  // Color code RPC usage
  const rpcColor = rpcPerMin > 100 ? theme.error
    : rpcPerMin > 50 ? theme.warning
    : theme.success;

  table.push(
    [theme.muted('Borrowers Tracked'), theme.accent(monitorStats.borrowersTracked || 0)],
    [theme.muted('At-Risk Positions'), theme.warning(monitorStats.atRiskCount || 0)],
    [theme.muted('Liquidatable'), theme.error(monitorStats.liquidatableCount || 0)],
    ['', ''],
    [theme.muted('Monitoring Mode'), modeStr],
    [theme.muted('Mempool Oracle Updates'), mempoolUpdates > 0 ? theme.success(mempoolUpdates) : theme.muted(mempoolUpdates)],
    [theme.muted('Oracles Watched'), mempoolWatched],
    ['', ''],
    [theme.muted('RPC Calls (total)'), rpcTotal],
    [theme.muted('RPC Calls/min'), rpcColor(rpcPerMin)],
    [theme.muted('Multicall Batches'), multicallBatches],
    ['', ''],
    [theme.muted('Liquidations Attempted'), liquidatorStats.liquidationsAttempted || 0],
    [theme.muted('Successful'), theme.success(liquidatorStats.liquidationsSuccessful || 0)],
    [theme.muted('Failed'), theme.error(liquidatorStats.liquidationsFailed || 0)],
    [theme.muted('Success Rate'), `${liquidatorStats.successRate || 0}%`],
    ['', ''],
    [theme.muted('Total Profit'), theme.profit(`$${(liquidatorStats.totalProfitUSD || 0).toFixed(2)}`)],
    [theme.muted('Gas Spent'), theme.loss(`$${(liquidatorStats.totalGasSpentUSD || 0).toFixed(2)}`)],
  );

  console.log(table.toString());
  console.log(theme.primary('═'.repeat(60)) + '\n');
}

/**
 * Print at-risk positions table
 */
function printAtRiskPositions(positions) {
  if (!positions || positions.length === 0) {
    console.log(theme.muted(`  ${icons.eye} No at-risk positions in target range\n`));
    return;
  }

  console.log(`\n  ${icons.warning} ${theme.warning.bold('AT-RISK POSITIONS')} (${positions.length})\n`);

  const table = new Table({
    head: [
      theme.muted('Borrower'),
      theme.muted('HF'),
      theme.muted('Debt'),
      theme.muted('Protocol'),
    ],
    style: { head: [], border: [] },
    colWidths: [16, 10, 12, 12],
  });

  for (const pos of positions.slice(0, 10)) {
    const hfColor = pos.healthFactor < 1.0 ? theme.error
      : pos.healthFactor < 1.05 ? theme.warning
      : theme.muted;

    table.push([
      `${pos.address.slice(0, 6)}...${pos.address.slice(-4)}`,
      hfColor(pos.healthFactor.toFixed(4)),
      `$${pos.totalDebtUSD.toFixed(0)}`,
      pos.protocol,
    ]);
  }

  console.log(table.toString());

  if (positions.length > 10) {
    console.log(theme.muted(`  ... and ${positions.length - 10} more\n`));
  }
}

/**
 * Print liquidatable positions (ready to execute!)
 */
function printLiquidatablePositions(positions) {
  if (!positions || positions.length === 0) {
    return;
  }

  console.log(`\n  ${icons.skull} ${theme.error.bold('LIQUIDATABLE POSITIONS')} (${positions.length})\n`);

  const table = new Table({
    head: [
      theme.muted('Borrower'),
      theme.muted('HF'),
      theme.muted('Debt'),
      theme.muted('Est. Profit'),
      theme.muted('Status'),
    ],
    style: { head: [], border: [] },
    colWidths: [16, 10, 12, 14, 12],
  });

  for (const pos of positions) {
    // Estimate profit (5% bonus minus fees)
    const estProfit = pos.totalDebtUSD * 0.05 * 0.5 * 0.95; // 50% liquidatable, 5% bonus, 5% costs

    table.push([
      `${pos.address.slice(0, 6)}...${pos.address.slice(-4)}`,
      theme.error(pos.healthFactor.toFixed(4)),
      `$${pos.totalDebtUSD.toFixed(0)}`,
      theme.profit(`~$${estProfit.toFixed(2)}`),
      theme.error(`${icons.fire} READY`),
    ]);
  }

  console.log(table.toString());
  console.log('');
}

/**
 * Print liquidation result
 */
function printLiquidationResult(result) {
  if (result.success) {
    console.log(boxen(
      `${icons.check} ${theme.success.bold('LIQUIDATION SUCCESSFUL!')}\n\n` +
      `${theme.muted('Profit:')} ${theme.profit(`$${result.profit.toFixed(2)}`)}\n` +
      `${theme.muted('Gas:')} ${theme.loss(`$${result.gasSpent?.toFixed(2) || '?'}`)}\n` +
      (result.txHash ? `${theme.muted('Tx:')} ${result.txHash.slice(0, 20)}...` : ''),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'green',
      }
    ));
  } else {
    console.log(boxen(
      `${icons.cross} ${theme.error.bold('LIQUIDATION FAILED')}\n\n` +
      `${theme.muted('Reason:')} ${result.reason || 'Unknown'}`,
      {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'red',
      }
    ));
  }
}

/**
 * Print startup info
 */
function printStartupInfo(config) {
  console.log(theme.muted('\n  Configuration:'));
  console.log(theme.muted(`  ├─ Min Profit:    $${config.minProfitUSD}`));
  console.log(theme.muted(`  ├─ Max Gas:       $${config.maxGasUSD}`));
  console.log(theme.muted(`  ├─ Debt Range:    $${config.minDebtUSD} - $${config.maxDebtUSD}`));
  console.log(theme.muted(`  ├─ Watch at HF:   < ${config.watchThreshold}`));
  console.log(theme.muted(`  └─ Dry Run:       ${config.dryRun ? 'Yes' : 'No'}`));
  console.log('');
}

/**
 * Print help message
 */
function printHelp() {
  console.log(`
${theme.primary.bold('Flash Liquidator Commands:')}

  ${theme.accent('node src/index.js')}              Start the bot
  ${theme.accent('node src/index.js --help')}       Show this help

${theme.primary.bold('Environment Variables:')}

  ${theme.muted('CHAIN')}                Chain to run on (POLYGON, ARBITRUM, BASE, etc.)
  ${theme.muted('PRIVATE_KEY')}          Your wallet private key
  ${theme.muted('MIN_PROFIT_USD')}       Minimum profit to execute ($2 default)
  ${theme.muted('MAX_GAS_USD')}          Maximum gas to spend ($5 default)
  ${theme.muted('MIN_DEBT_USD')}         Minimum debt size to target ($50 default)
  ${theme.muted('MAX_DEBT_USD')}         Maximum debt size to target ($5000 default)
  ${theme.muted('DRY_RUN')}              Set to 'true' for simulation mode

${theme.primary.bold('Strategy:')}

  This bot targets ${theme.accent('small liquidations')} that big bots skip.
  - Less competition = higher win rate
  - Small but consistent profits
  - Zero capital required (flash loans!)

${theme.primary.bold('Deploy Contract First:')}

  ${theme.accent('npx hardhat run scripts/deploy.js --network polygon')}

  Then add the contract address to your .env:
  ${theme.muted('POLYGON_CONTRACT_ADDRESS=0x...')}
`);
}

module.exports = {
  theme,
  icons,
  printBanner,
  printStatus,
  printAtRiskPositions,
  printLiquidatablePositions,
  printLiquidationResult,
  printStartupInfo,
  printHelp,
};

