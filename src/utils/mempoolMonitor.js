/**
 * Mempool Monitor
 *
 * Watches the mempool for pending oracle price updates.
 * When detected, instantly recalculates health factors for at-risk positions.
 * This gives us the same speed as MEV bots - we see price changes BEFORE they confirm!
 *
 * Architecture:
 * - Subgraph: Discovers WHO to monitor (borrowers)
 * - Mempool: Tells us WHEN to act (price updates)
 * - Together: Competitive liquidation bot
 */

const { ethers } = require('ethers');

// Chainlink Aggregator interface (for decoding price updates)
const CHAINLINK_AGGREGATOR_ABI = [
  'function latestAnswer() view returns (int256)',
  'function decimals() view returns (uint8)',
  'event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)',
];

// Aave Oracle interface
const AAVE_ORACLE_ABI = [
  'function getAssetPrice(address asset) view returns (uint256)',
  'function getAssetsPrices(address[] assets) view returns (uint256[])',
  'event AssetSourceUpdated(address indexed asset, address indexed source)',
];

// Known function selectors for oracle updates
const ORACLE_SELECTORS = {
  // Chainlink
  'transmit': '0xc9807539',           // Chainlink OCR transmit
  'submit': '0x202ee0ed',              // Chainlink submit answer
  // Aave
  'setAssetSources': '0xabfd5310',     // Aave set price sources
};

class MempoolMonitor {
  constructor(options = {}) {
    this.chainName = options.chainName || 'POLYGON';
    this.chain = options.chain;
    this.provider = options.provider;
    this.wsProvider = null;

    // Callbacks
    this.onPriceUpdate = options.onPriceUpdate || (() => {});
    this.onLiquidationOpportunity = options.onLiquidationOpportunity || (() => {});

    // Oracle addresses to watch
    this.oracleAddresses = new Set();
    this.chainlinkFeeds = new Map(); // asset -> feed address

    // At-risk positions (passed from HealthMonitor)
    this.atRiskPositions = [];

    // Rate limiting
    this.lastProcessedBlock = 0;
    this.pendingTxCache = new Set(); // Avoid processing same tx twice
    this.maxCacheSize = 10000;

    // Stats
    this.stats = {
      txProcessed: 0,
      oracleUpdatesDetected: 0,
      liquidationTriggered: 0,
      errors: 0,
    };

    // Running state
    this.isRunning = false;
  }

  /**
   * Initialize mempool monitoring
   */
  async initialize() {
    console.log(`\n📡 Initializing Mempool Monitor for ${this.chainName}...`);

    // Get WSS URL for mempool access
    const wssUrl = this.chain?.wssUrl || process.env[`${this.chainName}_WSS_URL`];

    if (!wssUrl) {
      console.log(`   ⚠️ No WebSocket URL - mempool monitoring DISABLED`);
      console.log(`   💡 Add ${this.chainName}_WSS_URL to .env for mempool access`);
      console.log(`   📝 Recommended: Alchemy, QuickNode, or Infura (paid plans)`);
      return false;
    }

    try {
      this.wsProvider = new ethers.WebSocketProvider(wssUrl);

      // CRITICAL: attach a socket-level error handler. Without a listener, an
      // ETIMEDOUT / connection reset on this socket becomes an uncaught
      // exception and looks like a crash. Mempool is a best-effort speed
      // boost - if the socket dies the bot must keep running on polling.
      this._attachSocketGuards();

      // Wait for connection
      await Promise.race([
        this.wsProvider.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('WebSocket timeout')), 10000)
        )
      ]);

      // Re-attach after ready - ethers may (re)create the underlying socket
      this._attachSocketGuards();

      console.log(`   ✅ WebSocket connected for mempool monitoring`);

      // Setup oracle addresses to watch
      await this.setupOracleAddresses();

      return true;

    } catch (err) {
      console.log(`   ⚠️ Mempool monitoring unavailable: ${err.message}`);
      console.log(`   📝 Continuing without mempool (polling still active)`);
      try { this.wsProvider?.destroy?.(); } catch (_) {}
      this.wsProvider = null;
      return false;
    }
  }

  /**
   * Attach error/close handlers to the underlying WebSocket so a dropped or
   * timed-out connection is handled here instead of crashing the process.
   * Safe to call multiple times - handlers are idempotent via a flag.
   */
  _attachSocketGuards() {
    const sock = this.wsProvider?.websocket;
    if (!sock || sock.__guarded || typeof sock.on !== 'function') return;
    sock.__guarded = true;
    sock.on('error', (err) => {
      console.log(`   ⚠️ Mempool WebSocket error: ${err?.message || err} - disabling mempool, polling continues`);
      try { this.wsProvider?.destroy?.(); } catch (_) {}
      this.wsProvider = null;
    });
    sock.on('close', () => {
      console.log(`   ⚠️ Mempool WebSocket closed - polling continues`);
      this.wsProvider = null;
    });
  }

  /**
   * Setup oracle addresses to monitor
   */
  async setupOracleAddresses() {
    // Add Aave oracle
    if (this.chain?.aaveV3?.oracle) {
      this.oracleAddresses.add(this.chain.aaveV3.oracle.toLowerCase());
      console.log(`   📊 Watching Aave Oracle: ${this.chain.aaveV3.oracle.slice(0, 10)}...`);
    }

    // Try to get Chainlink price feeds from Aave oracle
    try {
      const aaveOracle = new ethers.Contract(
        this.chain.aaveV3.oracle,
        [
          'function getSourceOfAsset(address asset) view returns (address)',
          'function BASE_CURRENCY() view returns (address)',
        ],
        this.provider
      );

      // Get feeds for common assets
      const assets = Object.values(this.chain?.tokens || {}).filter(Boolean);

      for (const asset of assets.slice(0, 10)) { // Limit to 10 to avoid spam
        try {
          const feed = await aaveOracle.getSourceOfAsset(asset);
          if (feed && feed !== ethers.ZeroAddress) {
            this.chainlinkFeeds.set(asset.toLowerCase(), feed.toLowerCase());
            this.oracleAddresses.add(feed.toLowerCase());
          }
        } catch (e) {
          // Asset not supported
        }
      }

      if (this.chainlinkFeeds.size > 0) {
        console.log(`   📊 Watching ${this.chainlinkFeeds.size} Chainlink price feeds`);
      }

    } catch (err) {
      console.log(`   ⚠️ Could not fetch Chainlink feeds: ${err.message?.slice(0, 50)}`);
    }

    console.log(`   📊 Total oracle addresses monitored: ${this.oracleAddresses.size}`);
  }

  /**
   * Start mempool monitoring
   */
  async start() {
    if (this.isRunning || !this.wsProvider) return;
    this.isRunning = true;

    console.log(`\n🔍 Starting Mempool Monitor...`);
    console.log(`   Mode: Watching for pending oracle transactions`);

    // Subscribe to pending transactions
    try {
      // Method 1: Standard pending transaction subscription
      this.wsProvider.on('pending', async (txHash) => {
        await this.processPendingTx(txHash);
      });

      console.log(`   ✅ Subscribed to pending transactions`);

    } catch (err) {
      console.log(`   ⚠️ Standard pending subscription failed, trying alternative...`);

      // Method 2: Poll for pending transactions (fallback)
      this.startPolling();
    }

    // Also listen for confirmed blocks (backup)
    this.wsProvider.on('block', async (blockNumber) => {
      this.lastProcessedBlock = blockNumber;

      // Clean up old cache entries
      if (this.pendingTxCache.size > this.maxCacheSize) {
        this.pendingTxCache.clear();
      }
    });
  }

  /**
   * Process a pending transaction
   */
  async processPendingTx(txHash) {
    // Skip if already processed
    if (this.pendingTxCache.has(txHash)) return;
    this.pendingTxCache.add(txHash);

    this.stats.txProcessed++;

    try {
      // Get transaction details
      const tx = await this.wsProvider.getTransaction(txHash);
      if (!tx || !tx.to) return;

      const to = tx.to.toLowerCase();

      // Check if it's an oracle we're watching
      if (!this.oracleAddresses.has(to)) return;

      // Check if it's a price update function
      const selector = tx.data?.slice(0, 10);
      const isOracleUpdate = Object.values(ORACLE_SELECTORS).includes(selector) ||
                            this.chainlinkFeeds.has(to);

      if (isOracleUpdate) {
        this.stats.oracleUpdatesDetected++;

        console.log(`\n   ⚡ PENDING ORACLE UPDATE DETECTED!`);
        console.log(`      TX: ${txHash.slice(0, 16)}...`);
        console.log(`      To: ${to.slice(0, 10)}...`);
        console.log(`      Selector: ${selector}`);

        // Trigger immediate health factor recalculation
        await this.handleOracleUpdate(tx);
      }

    } catch (err) {
      // Transaction might have been mined already or dropped
      this.stats.errors++;
    }
  }

  /**
   * Handle detected oracle update
   */
  async handleOracleUpdate(tx) {
    // Notify callback (HealthMonitor will recalculate all HFs)
    try {
      await this.onPriceUpdate({
        txHash: tx.hash,
        oracle: tx.to,
        timestamp: Date.now(),
        isPending: true,
      });
    } catch (err) {
      console.log(`   ⚠️ Price update callback failed: ${err.message?.slice(0, 50)}`);
    }
  }

  /**
   * Set at-risk positions (called by HealthMonitor)
   */
  setAtRiskPositions(positions) {
    this.atRiskPositions = positions || [];
  }

  /**
   * Polling fallback for RPCs that don't support pending subscriptions
   */
  startPolling() {
    console.log(`   📡 Using polling fallback for pending transactions`);

    // Poll every 500ms for new pending transactions
    this.pollingInterval = setInterval(async () => {
      try {
        // Use eth_pendingTransactions if available
        const pending = await this.wsProvider.send('eth_pendingTransactions', []);

        for (const tx of (pending || [])) {
          if (tx?.hash) {
            await this.processPendingTx(tx.hash);
          }
        }
      } catch (err) {
        // RPC might not support this method
      }
    }, 500);
  }

  /**
   * Stop monitoring
   */
  stop() {
    this.isRunning = false;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    if (this.wsProvider) {
      this.wsProvider.removeAllListeners();
    }

    console.log(`\n🛑 Mempool Monitor stopped`);
    console.log(`   Stats: ${this.stats.txProcessed} tx processed, ${this.stats.oracleUpdatesDetected} oracle updates`);
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      ...this.stats,
      oracleAddressesWatched: this.oracleAddresses.size,
      chainlinkFeeds: this.chainlinkFeeds.size,
      isRunning: this.isRunning,
    };
  }
}

module.exports = MempoolMonitor;




