/**
 * Flash Liquidator - Main Entry Point
 *
 * Zero-capital flash loan liquidation bot targeting small, consistent profits.
 *
 * Features:
 * - MEV Protection (private mempool submission)
 * - Smart gas bidding
 * - Price monitoring
 * - Telegram alerts
 * - Multi-chain support
 *
 * Usage:
 *   CHAIN=POLYGON node src/index.js
 *
 * Requirements:
 *   - PRIVATE_KEY in .env (for gas fees only - ~$5)
 *   - Deployed FlashLiquidatorV2 contract (POLYGON_CONTRACT_ADDRESS)
 *   - RPC URL for your chain
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { getChain, getSupportedChains } = require('./config/chains');
const HealthMonitor = require('./monitors/healthMonitor');
const PriceMonitor = require('./monitors/priceMonitor');
const Liquidator = require('./executors/liquidator');
const MEVProtection = require('./utils/mevProtection');
const GasBidder = require('./utils/gasBidder');
const TelegramNotifier = require('./utils/telegram');
const Multicall = require('./utils/multicall');
const UI = require('./utils/ui');

class FlashLiquidatorBot {
  constructor() {
    // Get chain from env
    this.chainName = (process.env.CHAIN || 'POLYGON').toUpperCase();
    this.chain = null;
    this.provider = null;
    this.wallet = null;

    // Core components
    this.healthMonitor = null;
    this.priceMonitor = null;
    this.liquidator = null;

    // Enhancement modules
    this.mevProtection = null;
    this.gasBidder = null;
    this.telegram = null;
    this.multicall = null;

    // State
    this.isRunning = false;
    this.mainLoopInterval = null;
    this.dailySummaryInterval = null;

    // Settings
    this.settings = {
      minProfitUSD: parseFloat(process.env.MIN_PROFIT_USD || '2'),
      maxGasUSD: parseFloat(process.env.MAX_GAS_USD || '5'),
      minDebtUSD: parseFloat(process.env.MIN_DEBT_USD || '50'),
      maxDebtUSD: parseFloat(process.env.MAX_DEBT_USD || '5000'),
      watchThreshold: parseFloat(process.env.WATCH_THRESHOLD || '1.15'),
      dryRun: process.env.DRY_RUN === 'true',
      statusInterval: parseInt(process.env.STATUS_INTERVAL || '60') * 1000,
      mevEnabled: process.env.USE_MEV_PROTECTION === 'true',
    };

    // Daily stats for summary
    this.dailyStats = {
      profitToday: 0,
      liquidationsToday: 0,
      startOfDay: Date.now(),
    };
  }

  /**
   * Initialize the bot
   */
  async initialize() {
    // Print banner
    UI.printBanner(this.chainName);

    // Check for help flag
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      UI.printHelp();
      process.exit(0);
    }

    // Validate chain
    this.chain = getChain(this.chainName);
    if (!this.chain) {
      console.log(UI.theme.error(`\n❌ Unsupported chain: ${this.chainName}`));
      console.log(UI.theme.muted(`   Supported: ${getSupportedChains().join(', ')}`));
      return false;
    }

    // Check private key
    if (!process.env.PRIVATE_KEY) {
      console.log(UI.theme.error('\n❌ PRIVATE_KEY not found in .env'));
      console.log(UI.theme.muted('   You need a small amount of gas (~$5) to execute liquidations'));
      return false;
    }

    // Create provider
    console.log(UI.theme.muted(`\n  Connecting to ${this.chain.name}...`));
    this.provider = new ethers.JsonRpcProvider(this.chain.rpcUrl);

    // Verify connection
    try {
      const network = await this.provider.getNetwork();
      if (Number(network.chainId) !== this.chain.chainId) {
        console.log(UI.theme.error(`\n❌ Wrong chain! Expected ${this.chain.chainId}, got ${network.chainId}`));
        return false;
      }
      console.log(UI.theme.success(`  ✅ Connected to ${this.chain.name} (chainId: ${network.chainId})`));
    } catch (error) {
      console.log(UI.theme.error(`\n❌ Failed to connect: ${error.message}`));
      return false;
    }

    // Create wallet
    this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);
    const balance = await this.provider.getBalance(this.wallet.address);
    const balanceNative = parseFloat(ethers.formatEther(balance));

    console.log(UI.theme.muted(`  Wallet: ${this.wallet.address}`));
    console.log(UI.theme.muted(`  Balance: ${balanceNative.toFixed(4)} ${this.chain.nativeToken}`));

    if (balanceNative < 0.001) {
      console.log(UI.theme.warning(`\n  ⚠️ Low balance! You need gas for liquidation transactions.`));
      console.log(UI.theme.muted(`     Recommended: ~$5 worth of ${this.chain.nativeToken}`));
    }

    // Print config
    UI.printStartupInfo(this.settings);

    // Initialize enhancement modules
    console.log(UI.theme.muted('\n  Initializing modules...'));

    // MEV Protection
    this.mevProtection = new MEVProtection(this.chainName);
    this.mevProtection.initialize(this.wallet, this.provider);

    // Smart Gas Bidder
    this.gasBidder = new GasBidder(this.chain, this.provider);
    console.log(`   ⛽ Smart Gas Bidding: ENABLED`);

    // Multicall for batched RPC
    this.multicall = new Multicall(this.provider, this.chainName);
    console.log(`   📦 Multicall Batching: ENABLED`);

    // Telegram Notifications
    this.telegram = new TelegramNotifier();
    if (this.telegram.isEnabled()) {
      console.log(`   📱 Telegram Alerts: ENABLED`);
    } else {
      console.log(`   📱 Telegram Alerts: DISABLED (add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)`);
    }

    // Initialize health monitor
    this.healthMonitor = new HealthMonitor(this.chain, this.provider, this.settings);
    await this.healthMonitor.initialize();

    // Initialize price monitor
    this.priceMonitor = new PriceMonitor(this.chain, this.provider);
    await this.priceMonitor.initialize();

    // Set up price drop alerts
    this.priceMonitor.setPriceDropCallback(async (drop) => {
      console.log(UI.theme.warning(`\n📉 Price drop detected! ${drop.symbol} -${drop.dropPercent.toFixed(2)}%`));
      console.log(UI.theme.muted(`   This may create liquidation opportunities!`));

      // Force immediate health check
      await this.healthMonitor.checkAllHealthFactors();
    });

    // Initialize liquidator with enhanced features
    const contractAddress = process.env[`${this.chainName}_CONTRACT_ADDRESS`] || process.env.CONTRACT_ADDRESS;
    this.liquidator = new Liquidator(this.chain, this.provider, this.wallet, this.settings);

    // Inject enhancement modules
    this.liquidator.mevProtection = this.mevProtection;
    this.liquidator.gasBidder = this.gasBidder;
    this.liquidator.telegram = this.telegram;

    await this.liquidator.initialize(contractAddress);

    // Send startup notification
    await this.telegram.notifyStartup({
      chain: this.chainName,
      minProfitUSD: this.settings.minProfitUSD,
      minDebtUSD: this.settings.minDebtUSD,
      maxDebtUSD: this.settings.maxDebtUSD,
      mevEnabled: this.settings.mevEnabled,
      dryRun: this.settings.dryRun,
    });

    return true;
  }

  /**
   * Start the bot
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(UI.theme.success(`\n${UI.icons.rocket} Starting Flash Liquidator Bot...`));
    console.log(UI.theme.muted(`   Watching for liquidation opportunities...\n`));

    // Start monitors
    this.healthMonitor.start();
    this.priceMonitor.start();

    // Main loop
    this.mainLoopInterval = setInterval(() => this.mainLoop(), this.settings.statusInterval);

    // Daily summary (every 24 hours)
    this.dailySummaryInterval = setInterval(() => this.sendDailySummary(), 24 * 60 * 60 * 1000);

    // Initial check
    await this.mainLoop();
  }

  /**
   * Main processing loop
   */
  async mainLoop() {
    try {
      // Print status
      const monitorStats = this.healthMonitor.getStats();
      const liquidatorStats = this.liquidator.getStats();
      const mevStats = this.mevProtection?.getStats() || {};
      const gasStats = this.gasBidder?.getStats() || {};

      UI.printStatus(monitorStats, liquidatorStats, this.chainName);

      // Show MEV protection stats if enabled
      if (this.settings.mevEnabled && mevStats.privateTxSent > 0) {
        console.log(UI.theme.muted(`   🔒 MEV: ${mevStats.privateTxSuccess}/${mevStats.privateTxSent} via private mempool`));
      }

      // Print at-risk positions
      const atRisk = this.healthMonitor.getAtRiskPositions();
      UI.printAtRiskPositions(atRisk);

      // Notify telegram about at-risk positions (once per hour)
      if (atRisk.length > 0) {
        await this.telegram.notifyAtRiskSummary(atRisk);
      }

      // Get liquidatable positions
      const liquidatable = this.healthMonitor.getLiquidatablePositions();
      UI.printLiquidatablePositions(liquidatable);

      // Execute liquidations
      if (liquidatable.length > 0) {
        console.log(UI.theme.error(`\n${UI.icons.fire} ${UI.icons.target} Found ${liquidatable.length} liquidatable position(s)!`));

        for (const position of liquidatable) {
          // Check gas before executing
          const isGasTooHigh = await this.gasBidder.isGasTooHigh(this.settings.maxGasUSD);
          if (isGasTooHigh) {
            console.log(UI.theme.warning(`   ⏳ Gas too high, waiting...`));
            continue;
          }

          // Estimate profit for gas bidding (small positions liquidate 100%
          // under Aave's dust rule, larger ones 50%)
          const liquidationFraction = position.totalDebtUSD <= 2000 ? 1 : 0.5;
          const estimatedProfit = position.totalDebtUSD * 0.05 * liquidationFraction * 0.95;

          // Get optimal gas settings
          const gasSettings = await this.gasBidder.calculateGasSettings(estimatedProfit, true);

          // Notify telegram about opportunity
          await this.telegram.notifyOpportunity({
            ...position,
            estimatedProfit,
            dryRun: this.settings.dryRun,
          });

          // Execute liquidation
          const result = await this.liquidator.liquidate(position, gasSettings);
          UI.printLiquidationResult(result);

          // Track daily stats
          if (result.success) {
            this.dailyStats.profitToday += result.profit || 0;
            this.dailyStats.liquidationsToday++;

            // Remove successfully liquidated position from tracking
            this.healthMonitor.removeBorrower(position.address);
            this.healthMonitor.removeLiquidatable(position.address);

            // Notify success
            await this.telegram.notifySuccess({
              ...result,
              explorerUrl: `${this.chain.explorer}/tx/${result.txHash}`,
              totalProfit: liquidatorStats.totalProfitUSD + (result.profit || 0),
            });
          } else {
            // Remove position if it failed due to: already liquidated, recovered, or no debt
            const shouldRemove = result.reason?.includes('already liquidated') ||
                                 result.reason?.includes('recovered') ||
                                 result.reason?.includes('HF=0') ||
                                 result.reason?.includes('Position is healthy') ||
                                 result.reason?.includes('verification failed');

            if (shouldRemove) {
              console.log(`   🗑️ Removing position from tracking (${result.reason})`);
              this.healthMonitor.removeBorrower(position.address);
              this.healthMonitor.removeLiquidatable(position.address);
            }

            await this.telegram.notifyFailure({ message: result.reason }, position);
          }

          // Small delay between liquidations
          await this.sleep(1000);
        }
      }

    } catch (error) {
      console.log(UI.theme.error(`\n❌ Main loop error: ${error.message}`));
      await this.telegram.notifyError(error);
    }
  }

  /**
   * Send daily summary
   */
  async sendDailySummary() {
    const liquidatorStats = this.liquidator.getStats();
    const monitorStats = this.healthMonitor.getStats();

    await this.telegram.notifyDailySummary({
      profitToday: this.dailyStats.profitToday,
      totalProfit: liquidatorStats.totalProfitUSD,
      successful: this.dailyStats.liquidationsToday,
      failed: liquidatorStats.liquidationsFailed,
      borrowersTracked: monitorStats.borrowersTracked,
    });

    // Reset daily stats
    this.dailyStats = {
      profitToday: 0,
      liquidationsToday: 0,
      startOfDay: Date.now(),
    };
  }

  /**
   * Stop the bot
   */
  stop() {
    this.isRunning = false;

    if (this.mainLoopInterval) {
      clearInterval(this.mainLoopInterval);
    }

    if (this.dailySummaryInterval) {
      clearInterval(this.dailySummaryInterval);
    }

    if (this.healthMonitor) {
      this.healthMonitor.stop();
    }

    if (this.priceMonitor) {
      this.priceMonitor.stop();
    }

    console.log(UI.theme.warning('\n🛑 Bot stopped'));
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============ MAIN ============

async function main() {
  const bot = new FlashLiquidatorBot();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n');
    bot.stop();

    const stats = bot.liquidator?.getStats() || {};
    const mevStats = bot.mevProtection?.getStats() || {};

    console.log(UI.theme.muted('\n📊 Final Stats:'));
    console.log(UI.theme.muted(`   Liquidations: ${stats.liquidationsSuccessful || 0}/${stats.liquidationsAttempted || 0}`));
    console.log(UI.theme.muted(`   Total Profit: $${(stats.totalProfitUSD || 0).toFixed(2)}`));
    console.log(UI.theme.muted(`   Gas Spent: $${(stats.totalGasSpentUSD || 0).toFixed(2)}`));

    if (bot.settings.mevEnabled) {
      console.log(UI.theme.muted(`   MEV Protected: ${mevStats.privateTxSuccess || 0}/${mevStats.privateTxSent || 0}`));
    }

    process.exit(0);
  });

  // Handle errors
  process.on('unhandledRejection', async (error) => {
    console.log(UI.theme.error(`\n❌ Unhandled rejection: ${error.message}`));
    await bot.telegram?.notifyError(error);
  });

  // Handle uncaught exceptions (like WebSocket errors)
  process.on('uncaughtException', async (error) => {
    // Ignore WebSocket auth/connection errors - they're not fatal
    if (error.message?.includes('401') || error.message?.includes('WebSocket')) {
      console.log(UI.theme.warning(`\n⚠️ WebSocket error (non-fatal): ${error.message}`));
      console.log(UI.theme.muted(`   Continuing in polling mode...`));
      return;
    }

    console.log(UI.theme.error(`\n❌ Uncaught exception: ${error.message}`));
    await bot.telegram?.notifyError(error);
    // Don't exit - try to continue
  });

  // Initialize and start
  const initialized = await bot.initialize();

  if (!initialized) {
    console.log(UI.theme.error('\n❌ Initialization failed. Check configuration and try again.'));
    process.exit(1);
  }

  await bot.start();
}

// Run
main().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
