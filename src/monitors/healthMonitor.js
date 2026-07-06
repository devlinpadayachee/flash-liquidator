/**
 * Health Factor Monitor - ENHANCED
 *
 * Monitors lending protocol positions and identifies liquidation opportunities.
 * Now with:
 * - 5000+ borrower limit via pagination
 * - Real-time price oracle monitoring
 * - Priority queue for riskiest positions
 * - Event-driven liquidation detection
 */

const { ethers } = require('ethers');
const {
  AAVE_POOL_ABI,
  AAVE_POOL_DATA_PROVIDER_ABI,
  AAVE_ORACLE_ABI,
  AAVE_POOL_EVENTS,
  VENUS_COMPTROLLER_ABI,
  VENUS_VTOKEN_ABI,
  PROTOCOL_TYPES,
  LIQUIDATION_BONUSES,
} = require('../config/protocols');
const SubgraphClient = require('../utils/subgraphClient');
const BorrowerCache = require('../utils/borrowerCache');
const Multicall = require('../utils/multicall');
const MempoolMonitor = require('../utils/mempoolMonitor');

// Priority queue for efficient at-risk position tracking
class PriorityQueue {
  constructor() {
    this.items = [];
  }

  enqueue(item, priority) {
    this.items.push({ item, priority });
    this.items.sort((a, b) => a.priority - b.priority); // Lower HF = higher priority
  }

  dequeue() {
    return this.items.shift()?.item;
  }

  peek() {
    return this.items[0]?.item;
  }

  clear() {
    this.items = [];
  }

  removeByAddress(addr) {
    const a = addr?.toLowerCase();
    if (!a) return false;
    const before = this.items.length;
    this.items = this.items.filter(i => i.item.address?.toLowerCase() !== a);
    return before !== this.items.length;
  }

  get length() {
    return this.items.length;
  }

  getAll() {
    return this.items.map(i => i.item);
  }
}

class HealthMonitor {
  constructor(chainConfig, provider, settings = {}) {
    this.chain = chainConfig;
    this.provider = provider;

    // Multicall for batching RPC calls (HUGE RPC savings!)
    this.multicall = new Multicall(provider, chainConfig.name);

    // Settings (optimized for small, consistent profits)
    this.settings = {
      minDebtUSD: parseFloat(settings.minDebtUSD || process.env.MIN_DEBT_USD || '50'),
      maxDebtUSD: parseFloat(settings.maxDebtUSD || process.env.MAX_DEBT_USD || '5000'),
      watchThreshold: parseFloat(settings.watchThreshold || process.env.WATCH_THRESHOLD || '1.15'),
      scanInterval: parseInt(settings.scanInterval || process.env.SCAN_INTERVAL || '300') * 1000,
      healthCheckInterval: parseInt(settings.healthCheckInterval || process.env.HEALTH_CHECK_INTERVAL || '30') * 1000,
      // NEW: Higher limits
      maxBorrowers: parseInt(settings.maxBorrowers || process.env.MAX_BORROWERS || '5000'),
      priorityCheckCount: parseInt(settings.priorityCheckCount || process.env.PRIORITY_CHECK_COUNT || '100'),
      // Multicall batch size (higher = fewer RPC calls but more data per call)
      multicallBatchSize: parseInt(settings.multicallBatchSize || process.env.MULTICALL_BATCH_SIZE || '50'),
      // Max at-risk positions to track (riskier positions replace less risky ones)
      maxAtRiskPositions: parseInt(settings.maxAtRiskPositions || process.env.MAX_AT_RISK_POSITIONS || '200'),
    };

    // Tracked borrowers: Map<address, BorrowerInfo>
    this.borrowers = new Map();

    // Persistent cache (survives restarts!)
    this.cache = new BorrowerCache(chainConfig.name);
    this.useCache = process.env.USE_CACHE !== 'false'; // Enabled by default

    // Priority queue for at-risk positions (sorted by HF, lowest first)
    this.priorityQueue = new PriorityQueue();

    // Rotating cursor over the FULL borrower population so every position is
    // re-priced on a fixed cadence — not just the perennial at-risk set. This
    // is what lets the bot catch a healthy position that suddenly decays.
    this.rotationCursor = 0;
    this.rotationWindow = parseInt(process.env.ROTATION_WINDOW || '200', 10);

    // Liquidatable positions (HF < 1.0)
    this.liquidatablePositions = [];

    // At-risk positions cache
    this.atRiskPositions = [];

    // Stats
    this.stats = {
      totalBorrowersTracked: 0,
      atRiskCount: 0,
      liquidatableCount: 0,
      scansCompleted: 0,
      lastScanTime: 0,
      priceUpdatesReceived: 0,
      eventsProcessed: 0,
      positionsReplaced: 0, // Track how many less risky positions were replaced
      // RPC call tracking
      rpcCalls: 0,
      multicallBatches: 0,
      rpcCallsLastMinute: 0,
      rpcCallsThisMinute: 0,
      lastMinuteReset: Date.now(),
    };

    // Protocol contracts
    this.aavePool = null;
    this.aaveDataProvider = null;
    this.aaveOracle = null;
    this.venusComptroller = null;

    // Subgraph client for borrower discovery
    this.subgraphClient = null;
    this.useSubgraph = process.env.USE_SUBGRAPH !== 'false';

    // Mempool monitor for instant oracle update detection
    this.mempoolMonitor = null;
    this.useMempool = process.env.USE_MEMPOOL !== 'false'; // Enabled by default if WSS available

    // Real-time event monitoring
    this.eventListeners = [];
    this.wsProvider = null;

    // Running state
    this.isRunning = false;
    this.scanTimer = null;
    this.checkTimer = null;
    this.priorityCheckTimer = null;
  }

  /**
   * Track RPC call for statistics
   */
  trackRpcCall(count = 1, isMulticall = false) {
    this.stats.rpcCalls += count;
    if (isMulticall) {
      this.stats.multicallBatches += 1;
    }
    this.stats.rpcCallsThisMinute += count;

    // Reset per-minute counter every 60 seconds
    const now = Date.now();
    if (now - this.stats.lastMinuteReset >= 60000) {
      this.stats.rpcCallsLastMinute = this.stats.rpcCallsThisMinute;
      this.stats.rpcCallsThisMinute = 0;
      this.stats.lastMinuteReset = now;
    }
  }

  /**
   * Add or update a position in the at-risk list
   * RISKIER positions (lower HF) REPLACE less risky ones (higher HF)
   * Returns: { added: boolean, replaced: address|null, updated: boolean }
   */
  addToAtRiskList(position) {
    const addr = position.address?.toLowerCase();
    if (!addr || !position.healthFactor || position.healthFactor <= 0.01) {
      return { added: false, replaced: null, updated: false };
    }

    // Skip dust positions: very low HF + tiny debt = already-liquidated remnants
    const minDebt = this.settings.minDebtUSD || 50;
    if (position.healthFactor < 0.5 && position.totalDebtUSD < minDebt) {
      return { added: false, replaced: null, updated: false };
    }

    // Check if already in list - update if so (NOT a new add!)
    const existingIdx = this.atRiskPositions.findIndex(
      p => p.address?.toLowerCase() === addr
    );

    if (existingIdx >= 0) {
      // Update existing entry - NOT counted as "new"
      this.atRiskPositions[existingIdx] = { ...position };
      return { added: false, replaced: null, updated: true };
    }

    // Not in list - check if we should add
    const maxPositions = this.settings.maxAtRiskPositions;

    if (this.atRiskPositions.length < maxPositions) {
      // Room available - just add
      this.atRiskPositions.push({ ...position });
      // Sort by HF (lowest first = riskiest first)
      this.atRiskPositions.sort((a, b) => a.healthFactor - b.healthFactor);
      return { added: true, replaced: null, updated: false };
    }

    // List is full - check if new position is riskier than the least risky
    // Sort first to ensure we have correct order
    this.atRiskPositions.sort((a, b) => a.healthFactor - b.healthFactor);

    const leastRisky = this.atRiskPositions[this.atRiskPositions.length - 1];

    if (position.healthFactor < leastRisky.healthFactor) {
      // New position is riskier - REPLACE the least risky
      const replacedAddr = leastRisky.address;
      this.atRiskPositions.pop(); // Remove least risky
      this.atRiskPositions.push({ ...position });
      // Re-sort
      this.atRiskPositions.sort((a, b) => a.healthFactor - b.healthFactor);
      this.stats.positionsReplaced++;

      // Only log if DEBUG mode (avoid spam)
      if (process.env.DEBUG_REPLACEMENTS === 'true') {
        console.log(`   🔄 Replaced ${replacedAddr?.slice(0, 10)}... (HF=${leastRisky.healthFactor?.toFixed(4)}) with ${addr?.slice(0, 10)}... (HF=${position.healthFactor.toFixed(4)})`);
      }

      return { added: true, replaced: replacedAddr, updated: false };
    }

    // New position is less risky than all current ones - don't add
    return { added: false, replaced: null, updated: false };
  }

  /**
   * Evict positions whose health factor has recovered comfortably above the
   * watch threshold from both the at-risk list and the priority queue.
   *
   * Uses hysteresis (watchThreshold * 1.03) so a position sitting right on the
   * boundary doesn't flap in and out every cycle. Liquidatable positions
   * (HF < 1) are never touched here. Returns the number evicted.
   */
  pruneRecovered() {
    const recover = this.settings.watchThreshold * 1.03;
    const freshHF = (addr) => {
      const b = this.borrowers.get(addr?.toLowerCase());
      return b && typeof b.healthFactor === 'number' ? b.healthFactor : null;
    };
    const isRecovered = (addr) => {
      const hf = freshHF(addr);
      return hf !== null && hf >= recover;
    };

    const beforeAR = this.atRiskPositions.length;
    this.atRiskPositions = this.atRiskPositions.filter(p => !isRecovered(p.address));
    const evicted = beforeAR - this.atRiskPositions.length;

    // Also drop recovered entries from the priority queue so the top-N it
    // hands out isn't clogged with positions that no longer matter.
    this.priorityQueue.items = this.priorityQueue.items.filter(
      i => !isRecovered(i.item.address)
    );

    return evicted;
  }

  /**
   * Initialize protocol contracts and subgraph client
   */
  async initialize() {
    console.log(`\n📡 Initializing Health Monitor for ${this.chain.name}...`);

    // Load cached borrowers first (survives restarts!)
    if (this.useCache) {
      this.cache.load();

      // Prune old closed positions if list is too large
      // This prevents the closed list from blocking new borrowers forever
      const maxClosedPositions = parseInt(process.env.MAX_CLOSED_POSITIONS || '5000', 10);
      if (this.cache.stats.closedTracked > maxClosedPositions) {
        console.log(`   ⚠️ Closed list has ${this.cache.stats.closedTracked} entries (max: ${maxClosedPositions})`);
        this.cache.pruneClosedPositions(7 * 24 * 60 * 60 * 1000, maxClosedPositions);
      }

      // Option to clear ALL closed positions (set CLEAR_CLOSED_CACHE=true in .env)
      if (process.env.CLEAR_CLOSED_CACHE === 'true') {
        const cleared = this.cache.clearClosedPositions();
        console.log(`   🗑️ Cleared ${cleared} closed positions (CLEAR_CLOSED_CACHE=true)`);
      }

      // Copy cached borrowers to active tracking
      const cachedBorrowers = this.cache.getBorrowers();
      for (const [addr, data] of cachedBorrowers) {
        this.borrowers.set(addr, data);
      }

      if (this.borrowers.size > 0) {
        console.log(`   💾 Restored ${this.borrowers.size} borrowers from cache`);

        // Clean up any invalid positions loaded from cache
        this.cleanupInvalidPositions();
      }
    }

    // Initialize Aave V3 if available
    if (this.chain.aaveV3) {
      this.aavePool = new ethers.Contract(
        this.chain.aaveV3.pool,
        AAVE_POOL_ABI,
        this.provider
      );

      this.aaveDataProvider = new ethers.Contract(
        this.chain.aaveV3.poolDataProvider,
        AAVE_POOL_DATA_PROVIDER_ABI,
        this.provider
      );

      this.aaveOracle = new ethers.Contract(
        this.chain.aaveV3.oracle,
        AAVE_ORACLE_ABI,
        this.provider
      );

      console.log(`   ✅ Aave V3 Pool: ${this.chain.aaveV3.pool.slice(0, 10)}...`);
    }

    // Initialize Venus if available (BSC)
    if (this.chain.venus) {
      this.venusComptroller = new ethers.Contract(
        this.chain.venus.comptroller,
        VENUS_COMPTROLLER_ABI,
        this.provider
      );

      console.log(`   ✅ Venus Comptroller: ${this.chain.venus.comptroller.slice(0, 10)}...`);
    }

    // Initialize Subgraph Client (for discovering WHO to monitor)
    if (this.useSubgraph) {
      try {
        this.subgraphClient = new SubgraphClient(this.chain.name);
        await this.subgraphClient.initialize();
        console.log(`   ✅ Subgraph Client initialized`);
      } catch (err) {
        console.log(`   ⚠️ Subgraph unavailable, using RPC fallback: ${err.message}`);
        this.useSubgraph = false;
      }
    }

    // Do initial borrower scan with high limit
    await this.scanForBorrowers();

    // Initialize Mempool Monitor (for knowing WHEN to act - oracle price updates)
    if (this.useMempool) {
      try {
        this.mempoolMonitor = new MempoolMonitor({
          chainName: this.chain.name,
          chain: this.chain,
          provider: this.provider,
          onPriceUpdate: async (event) => {
            // CRITICAL: When we see a pending oracle update, immediately recheck all at-risk positions!
            console.log(`\n   🔥 MEMPOOL: Oracle update detected! Rechecking ${this.atRiskPositions.length} at-risk positions...`);
            await this.recheckBufferZone();
          },
        });

        const initialized = await this.mempoolMonitor.initialize();
        if (initialized) {
          console.log(`   ✅ Mempool Monitor initialized (watching for oracle updates)`);
        }
      } catch (err) {
        console.log(`   ⚠️ Mempool monitoring unavailable: ${err.message}`);
        this.useMempool = false;
      }
    }

    // Initialize WebSocket for real-time events
    await this.initializeEventListeners();

    console.log(`   📊 Tracking ${this.borrowers.size} borrowers`);
    console.log(`   🎯 Target debt range: $${this.settings.minDebtUSD} - $${this.settings.maxDebtUSD}`);
    console.log(`   👁️ Watch threshold: HF < ${this.settings.watchThreshold}`);
    console.log(`   ⚡ Priority check: Top ${this.settings.priorityCheckCount} riskiest positions`);

    // Recheck cached liquidatable positions from previous session
    if (this.useCache) {
      await this.recheckCachedLiquidatables();
    }

    return true;
  }

  /**
   * Recheck liquidatable positions that were cached from previous session
   * Verifies they're still liquidatable before adding to active list
   */
  async recheckCachedLiquidatables() {
    const cached = this.cache.getLiquidatablePositions();
    if (cached.length === 0) return;

    console.log(`\n   🔄 Rechecking ${cached.length} cached liquidatable positions...`);

    let stillValid = 0;
    let noLongerValid = 0;
    let closed = 0;

    for (const pos of cached) {
      try {
        const result = await this.checkBorrowerHealth(pos);

        if (!result || result.totalDebtUSD < 1) {
          // Position closed
          this.cache.markClosed(pos.address);
          this.cache.removeLiquidatable(pos.address);
          closed++;
          continue;
        }

        // FIX: Filter out HF=0 (invalid/already liquidated)
        if (result.healthFactor < 1.0 && result.healthFactor > 0.01) {
          // Still liquidatable! Add to active list
          this.liquidatablePositions.push({
            ...pos,
            ...result,
            lastChecked: Date.now(),
          });
          stillValid++;
        } else if (result.healthFactor <= 0.01) {
          // HF = 0 means position is invalid/closed
          this.cache.markClosed(pos.address);
          this.cache.removeLiquidatable(pos.address);
          closed++;
        } else {
          // No longer liquidatable (HF recovered)
          this.cache.removeLiquidatable(pos.address);
          noLongerValid++;

          // But if still at-risk, add to priority queue (filter out HF=0)
          if (result.healthFactor < this.settings.watchThreshold && result.healthFactor > 0.01) {
            this.priorityQueue.enqueue({
              ...pos,
              ...result,
            }, result.healthFactor);
          }
        }
      } catch (e) {
        // Keep in cache for next check
      }

      // Small delay between checks
      await new Promise(r => setTimeout(r, 50));
    }

    // Sort by HF
    this.liquidatablePositions.sort((a, b) => a.healthFactor - b.healthFactor);
    this.stats.liquidatableCount = this.liquidatablePositions.length;

    console.log(`   ✅ Recheck complete: ${stillValid} still valid, ${noLongerValid} recovered, ${closed} closed`);

    // Clear the cache file (we've processed them)
    this.cache.clearLiquidatableCache();
  }

  /**
   * Initialize real-time event listeners for instant liquidation detection
   */
  async initializeEventListeners() {
    // Get WebSocket URL
    const wssUrl = this.chain.wssUrl || process.env[`${this.chain.name?.toUpperCase()}_WSS_URL`];

    if (!wssUrl) {
      console.log(`   ⚠️ No WebSocket URL - real-time events disabled`);
      console.log(`      Add ${this.chain.name?.toUpperCase()}_WSS_URL to .env for instant detection`);
      return;
    }

    try {
      this.wsProvider = new ethers.WebSocketProvider(wssUrl);

      // Attach socket guards immediately so a connect-time ETIMEDOUT is caught
      // here rather than surfacing as an uncaught exception.
      this._attachSocketGuards();

      // Wait for connection with timeout
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('WebSocket connection timeout')), 10000)
      );
      await Promise.race([this.wsProvider.ready, timeout]);

      // Re-attach after ready - ethers may swap the underlying socket
      this._attachSocketGuards();
      console.log(`   ✅ WebSocket connected for real-time events`);

      // Listen for price oracle updates (triggers health recalculation)
      if (this.aaveOracle) {
        await this.setupPriceOracleListener();
      }

      // Listen for new Borrow events (new positions to track)
      if (this.aavePool) {
        await this.setupBorrowEventListener();
      }

      // Listen for Repay events (positions being closed)
      if (this.aavePool) {
        await this.setupRepayEventListener();
      }

    } catch (err) {
      console.log(`   ⚠️ WebSocket failed: ${err.message}`);
      console.log(`      Falling back to polling mode`);
      try { this.wsProvider?.destroy?.(); } catch (_) {}
      this.wsProvider = null;
    }
  }

  /**
   * Attach error/close handlers to the underlying WebSocket so a dropped or
   * timed-out real-time connection is handled here instead of crashing the
   * process. Real-time events are an optimization; polling is the fallback.
   * Idempotent - safe to call multiple times.
   */
  _attachSocketGuards() {
    const sock = this.wsProvider?.websocket;
    if (!sock || sock.__guarded || typeof sock.on !== 'function') return;
    sock.__guarded = true;
    sock.on('error', (err) => {
      console.log(`   ⚠️ WebSocket error: ${err?.message || err} - continuing in polling mode`);
      try { this.wsProvider?.destroy?.(); } catch (_) {}
      this.wsProvider = null;
    });
    sock.on('close', () => {
      console.log(`   ⚠️ WebSocket closed - continuing in polling mode`);
      this.wsProvider = null;
    });
  }

  /**
   * Setup price oracle listener - react instantly when prices change
   */
  async setupPriceOracleListener() {
    try {
      // Aave oracle emits AssetSourceUpdated when prices change
      const oracleWs = new ethers.Contract(
        this.chain.aaveV3.oracle,
        [
          'event AssetSourceUpdated(address indexed asset, address indexed source)',
          'event BaseCurrencySet(address indexed baseCurrency, uint256 baseCurrencyUnit)',
        ],
        this.wsProvider
      );

      // Debounce to avoid spam (prices can update rapidly)
      let lastPriceCheck = 0;
      const PRICE_CHECK_COOLDOWN = 3000; // 3 seconds

      oracleWs.on('*', async (event) => {
        this.stats.priceUpdatesReceived++;

        // Debounce rapid price updates
        const now = Date.now();
        if (now - lastPriceCheck < PRICE_CHECK_COOLDOWN) {
          return;
        }
        lastPriceCheck = now;

        console.log(`\n   ⚡ PRICE UPDATE DETECTED!`);

        // CRITICAL: Check ALL positions in the buffer zone (HF 1.0 - 1.50)
        // A price drop could push ANY of them into liquidatable territory
        await this.recheckBufferZone();
      });

      this.eventListeners.push(oracleWs);
      console.log(`   📡 Price oracle listener active`);

    } catch (err) {
      console.log(`   ⚠️ Price oracle listener failed: ${err.message?.slice(0, 50)}`);
    }
  }

  /**
   * Recheck ALL positions in the "buffer zone" (HF 1.0 - 1.50)
   * Called when prices change - could push safe positions into liquidatable!
   */
  async recheckBufferZone() {
    const BUFFER_THRESHOLD = 1.50; // Check anything below 1.50
    const batchSize = 50;

    // Find all positions in buffer zone
    const bufferPositions = [];
    for (const [addr, borrower] of this.borrowers) {
      const hf = borrower.healthFactor;
      // Include: has HF data AND below buffer threshold
      if (hf && hf < BUFFER_THRESHOLD && hf > 0) {
        bufferPositions.push(borrower);
      }
    }

    if (bufferPositions.length === 0) {
      console.log(`   └── No positions in buffer zone (HF < ${BUFFER_THRESHOLD})`);
      return;
    }

    // Sort by HF (riskiest first)
    bufferPositions.sort((a, b) => a.healthFactor - b.healthFactor);

    // Limit to prevent RPC overload
    const toCheck = bufferPositions.slice(0, 500);
    console.log(`   └── Rechecking ${toCheck.length} buffer zone positions (HF < ${BUFFER_THRESHOLD})...`);

    const now = Date.now();
    let newAtRisk = 0;
    let newLiquidatable = 0;

    // FIX #3: DON'T fully clear - preserve very recent data, then add new
    const existingAtRisk = this.priorityQueue.getAll();
    const veryRecent = existingAtRisk.filter(p => {
      const age = now - (p.lastChecked || 0);
      return age < 5000; // Keep positions checked in last 5s (being checked now)
    });

    this.priorityQueue.clear();
    for (const pos of veryRecent) {
      this.priorityQueue.enqueue(pos, pos.healthFactor);
    }
    // DON'T reset atRiskPositions here - just let addToAtRiskList handle updates

    // Use MULTICALL for buffer zone recheck (huge RPC savings!)
    const multicallBatchSize = this.settings.multicallBatchSize || 100;

    for (let i = 0; i < toCheck.length; i += multicallBatchSize) {
      const batch = toCheck.slice(i, i + multicallBatchSize);
      const addresses = batch.map(b => b.address);

      // ONE RPC call for entire batch!
      const healthResults = await this.batchCheckAaveHealth(addresses);

      for (const borrower of batch) {
        const addr = borrower.address?.toLowerCase();
        const result = healthResults.get(addr);

        if (result && result.totalDebtUSD >= 1) {
          // Update borrower data
          borrower.healthFactor = result.healthFactor;
          borrower.totalDebtUSD = result.totalDebtUSD;
          borrower.totalCollateralUSD = result.totalCollateralUSD;
          borrower.lastChecked = now;

          // Check debt range
          const inRange = result.totalDebtUSD >= this.settings.minDebtUSD &&
                         result.totalDebtUSD <= this.settings.maxDebtUSD;

          // Track at-risk positions OUTSIDE debt range (for diagnostics)
          if (!inRange && result.healthFactor < this.settings.watchThreshold && result.healthFactor > 0.01) {
            if (result.totalDebtUSD < this.settings.minDebtUSD) {
              lowDebtCount++;
            } else {
              highDebtCount++;
            }
            // Still skip - but now we know WHY
            continue;
          }

          if (!inRange) continue;

          // Add to priority queue if at-risk (with deduplication! Filter HF=0)
          if (result.healthFactor < this.settings.watchThreshold && result.healthFactor > 0.01) {
            // Check if already in queue
            const inQueue = this.priorityQueue.getAll().find(p => p.address?.toLowerCase() === addr);
            if (!inQueue) {
              this.priorityQueue.enqueue({
                ...borrower,
                ...result,
              }, result.healthFactor);
            }

            // Add to at-risk list (riskier positions replace less risky ones)
            const addResult = this.addToAtRiskList({
              ...borrower,
              ...result,
            });
            if (addResult.added && !addResult.replaced) {
              newAtRisk++;
            }
          }

          // Track liquidatable positions (filter out HF=0 as invalid)
          if (result.healthFactor < 1.0 && result.healthFactor > 0.01) {
            const exists = this.liquidatablePositions.find(
              p => p.address?.toLowerCase() === addr
            );
            if (!exists) {
              const liqPos = {
                ...borrower,
                ...result,
              };
              this.liquidatablePositions.push(liqPos);
              // Save to cache for persistence
              if (this.useCache) {
                this.cache.addLiquidatable(liqPos);
              }
              newLiquidatable++;
              console.log(`   🎯 NEW LIQUIDATABLE: ${borrower.address?.slice(0, 10)}... HF=${result.healthFactor.toFixed(4)} Debt=$${result.totalDebtUSD.toFixed(0)}`);
            }
          }
        }
      }

      // Small delay between multicall batches
      if (i + multicallBatchSize < toCheck.length) {
        await new Promise(r => setTimeout(r, 50));
      }
    }

    // Sort results
    this.atRiskPositions.sort((a, b) => a.healthFactor - b.healthFactor);
    this.liquidatablePositions.sort((a, b) => a.healthFactor - b.healthFactor);

    // Update stats
    this.stats.atRiskCount = this.atRiskPositions.length;
    this.stats.liquidatableCount = this.liquidatablePositions.length;

    // Log results
    console.log(`   └── Buffer recheck complete: ${newAtRisk} at-risk, ${newLiquidatable} liquidatable`);

    if (this.priorityQueue.length > 0) {
      const top = this.priorityQueue.peek();
      console.log(`   └── Riskiest: ${top?.address?.slice(0, 10)}... HF=${top?.healthFactor?.toFixed(4)}`);
    }

    // Save to cache if we found changes
    if (this.useCache && (newAtRisk > 0 || newLiquidatable > 0)) {
      this.syncToCache();
    }
  }

  /**
   * Setup Borrow event listener - track new borrowers instantly
   */
  async setupBorrowEventListener() {
    try {
      const poolWs = new ethers.Contract(
        this.chain.aaveV3.pool,
        AAVE_POOL_ABI,
        this.wsProvider
      );

      poolWs.on('Borrow', async (reserve, user, onBehalfOf, amount, interestRateMode, borrowRate, referralCode, event) => {
        this.stats.eventsProcessed++;

        const borrower = onBehalfOf || user;
        const addr = borrower?.toLowerCase();

        // FIX: If they borrow again after being closed, REACTIVATE them!
        if (this.useCache && this.cache.isClosed(addr)) {
          this.cache.reactivate(addr);
          console.log(`   🔄 Reactivated borrower (was closed): ${addr.slice(0, 10)}...`);
        }

        if (addr && !this.borrowers.has(addr)) {
          console.log(`   📥 New borrower detected: ${addr.slice(0, 10)}...`);

          this.borrowers.set(addr, {
            address: borrower,
            protocol: 'AAVE_V3',
            lastChecked: 0,
            healthFactor: null,
            totalDebtUSD: null,
            totalCollateralUSD: null,
            isNew: true,
          });

          // Check health immediately
          try {
            const result = await this.checkAaveHealth(borrower);
            if (result) {
              this.borrowers.get(addr).healthFactor = result.healthFactor;
              this.borrowers.get(addr).totalDebtUSD = result.totalDebtUSD;

              // Add to queue if at-risk (filter out HF=0)
              if (result.healthFactor < this.settings.watchThreshold && result.healthFactor > 0.01) {
                this.priorityQueue.enqueue(this.borrowers.get(addr), result.healthFactor);
              }
            }
          } catch (e) {}

          this.stats.totalBorrowersTracked = this.borrowers.size;
        }
      });

      this.eventListeners.push(poolWs);
      console.log(`   📡 Borrow event listener active`);

    } catch (err) {
      console.log(`   ⚠️ Borrow event listener failed: ${err.message?.slice(0, 50)}`);
    }
  }

  /**
   * Setup Repay event listener - remove closed positions
   */
  async setupRepayEventListener() {
    try {
      const poolWs = new ethers.Contract(
        this.chain.aaveV3.pool,
        AAVE_POOL_ABI,
        this.wsProvider
      );

      poolWs.on('Repay', async (reserve, user, repayer, amount, useATokens, event) => {
        this.stats.eventsProcessed++;

        // When repay happens, check if position is fully closed
        const addr = user?.toLowerCase();
        if (addr && this.borrowers.has(addr)) {
          try {
            const result = await this.checkAaveHealth(user);
            if (!result || result.totalDebtUSD < 1) {
              // Position closed, remove from tracking
              this.borrowers.delete(addr);
              console.log(`   📤 Position closed: ${addr.slice(0, 10)}...`);
            }
          } catch (e) {}
        }
      });

      this.eventListeners.push(poolWs);
      console.log(`   📡 Repay event listener active`);

    } catch (err) {
      console.log(`   ⚠️ Repay event listener failed: ${err.message?.slice(0, 50)}`);
    }
  }

  /**
   * Start monitoring
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`\n🚀 Starting Health Monitor...`);
    console.log(`   Mode: ${this.wsProvider ? 'Real-time events + Polling' : 'Polling only'}`);

    // Periodic borrower scan (find new borrowers)
    this.scanTimer = setInterval(
      () => this.scanForBorrowers(),
      this.settings.scanInterval
    );

    // Frequent health checks (all positions)
    this.checkTimer = setInterval(
      () => this.checkAllHealthFactors(),
      this.settings.healthCheckInterval
    );

    // PRIORITY: Check riskiest positions every 5 seconds
    this.priorityCheckTimer = setInterval(
      () => this.checkPriorityPositions(),
      5000
    );

    // DIAGNOSTIC: Check for liquidations we might have missed (every 5 min)
    this.liquidationCheckTimer = setInterval(
      () => this.checkMissedLiquidations(),
      5 * 60 * 1000
    );

    // DIAGNOSTIC: Check WebSocket health every 2 minutes
    this.wsHealthTimer = setInterval(
      () => this.checkWebSocketHealth(),
      2 * 60 * 1000
    );

    // Start mempool monitoring (watches for pending oracle updates)
    if (this.mempoolMonitor) {
      this.mempoolMonitor.start();
      // Keep mempool monitor updated with current at-risk positions
      this.mempoolMonitor.setAtRiskPositions(this.atRiskPositions);
    }

    // Initial checks
    this.checkAllHealthFactors();

    // Run liquidation check after 30 seconds (let things stabilize first)
    setTimeout(() => this.checkMissedLiquidations(), 30000);

    // Run WebSocket health check after 60 seconds
    setTimeout(() => this.checkWebSocketHealth(), 60000);
  }

  /**
   * DIAGNOSTIC: Check if WebSocket is actually receiving events
   */
  checkWebSocketHealth() {
    const priceUpdates = this.stats.priceUpdatesReceived || 0;
    const eventsProcessed = this.stats.eventsProcessed || 0;

    if (!this.wsProvider) {
      console.log(`\n   ⚠️ WebSocket not connected - running in polling-only mode`);
      return;
    }

    console.log(`\n   📡 WebSocket Health Check:`);
    console.log(`      ├─ Price updates received: ${priceUpdates}`);
    console.log(`      ├─ Borrow/Repay events: ${eventsProcessed}`);

    if (priceUpdates === 0 && eventsProcessed === 0) {
      console.log(`      └─ ⚠️ NO EVENTS received! WebSocket may be stale`);
      console.log(`         Consider: Upgrading RPC or using a different WSS endpoint`);

      // Try to reconnect
      this.attemptWsReconnect();
    } else {
      console.log(`      └─ ✅ Events are flowing`);
    }
  }

  /**
   * Attempt to reconnect WebSocket if stale
   */
  async attemptWsReconnect() {
    console.log(`\n   🔄 Attempting WebSocket reconnection...`);

    try {
      // Cleanup old connection
      for (const listener of this.eventListeners) {
        try { listener.removeAllListeners(); } catch (e) {}
      }
      this.eventListeners = [];

      if (this.wsProvider) {
        try { this.wsProvider.destroy(); } catch (e) {}
      }

      // Reconnect
      await this.initializeEventListeners();

    } catch (err) {
      console.log(`   ❌ Reconnection failed: ${err.message?.slice(0, 50)}`);
    }
  }

  /**
   * DIAGNOSTIC: Check for recent on-chain liquidations we might have missed
   * This helps verify if the bot is actually catching opportunities
   */
  async checkMissedLiquidations() {
    if (!this.aavePool) return;

    try {
      this.trackRpcCall(1); // getBlockNumber
      const currentBlock = await this.provider.getBlockNumber();
      const fromBlock = currentBlock - 1000; // Last ~30 minutes on Polygon

      // Query LiquidationCall events
      const filter = this.aavePool.filters.LiquidationCall?.() || null;
      if (!filter) return;

      this.trackRpcCall(1); // queryFilter
      const events = await this.aavePool.queryFilter(filter, fromBlock, currentBlock);

      if (events.length > 0) {
        console.log(`\n   ⚠️ MISSED LIQUIDATIONS DETECTED!`);
        console.log(`   Found ${events.length} liquidations in last ~30 min:`);

        let missedOurs = 0;
        let outsideRange = 0;

        for (const event of events.slice(-5)) { // Show last 5
          const user = event.args?.user?.toLowerCase();
          const debtAsset = event.args?.debtAsset;
          const collateralAsset = event.args?.collateralAsset;
          const debtToCover = event.args?.debtToCover;

          const wasTracked = this.borrowers.has(user) || this.cache?.isClosed(user);
          const debtUSD = parseFloat(ethers.formatUnits(debtToCover || 0n, 18)) || 0;
          const inRange = debtUSD >= this.settings.minDebtUSD && debtUSD <= this.settings.maxDebtUSD;

          console.log(`      └─ ${user?.slice(0, 10)}... | Tracked: ${wasTracked ? '✅' : '❌'} | In range: ${inRange ? '✅' : '❌'}`);

          if (wasTracked && inRange) missedOurs++;
          if (!inRange) outsideRange++;
        }

        if (missedOurs > 0) {
          console.log(`\n   🚨 ${missedOurs} liquidation(s) were in YOUR target range but you missed them!`);
          console.log(`      This means competitors are faster. Consider:`);
          console.log(`      - Using a faster RPC (paid tier)`);
          console.log(`      - Reducing HEALTH_CHECK_INTERVAL to 10s`);
          console.log(`      - Enabling MEV protection with private mempool`);
        } else if (outsideRange > 0) {
          console.log(`\n   ℹ️ ${outsideRange} liquidation(s) were outside your debt range ($${this.settings.minDebtUSD}-$${this.settings.maxDebtUSD})`);
        } else {
          console.log(`\n   ✅ All recent liquidations were either not tracked or outside your range`);
        }

        this.stats.missedLiquidations = (this.stats.missedLiquidations || 0) + missedOurs;
      } else {
        console.log(`\n   ✅ No liquidations in last ~30 min on ${this.chain.name} Aave V3`);
        console.log(`      (This is normal when markets are stable)`);
      }
    } catch (err) {
      // Silent - LiquidationCall event might not be in ABI
    }
  }

  /**
   * Check only the riskiest positions (priority queue)
   * This runs every 5 seconds for instant reaction
   * FIX #5: Also sample some borderline positions to discover newly at-risk
   */
  async checkPriorityPositions() {
    const now = Date.now();

    // ALWAYS include positions from atRiskPositions (these MUST be rechecked!)
    const atRiskAddresses = new Set(
      this.atRiskPositions.map(p => p.address?.toLowerCase()).filter(Boolean)
    );

    // FIX #5: Also check some "borderline" positions not yet in queue
    // These could have become at-risk since last full check!
    const borderlinePositions = [];
    const BORDERLINE_THRESHOLD = 1.30; // Check anything below 1.30

    // Precompute the queued addresses ONCE. The old code ran a linear
    // priorityQueue.find() inside this per-borrower loop — O(n²) every 5s,
    // which itself made the loop sluggish as the population grew.
    const queuedAddrs = new Set(
      this.priorityQueue.getAll().map(p => p.address?.toLowerCase())
    );
    for (const [addr, borrower] of this.borrowers) {
      const hf = borrower.healthFactor;
      const age = now - (borrower.lastChecked || 0);

      // Include: has HF data, below borderline, not recently checked, NOT already in queue
      if (hf && hf < BORDERLINE_THRESHOLD && hf >= this.settings.watchThreshold && age > 10000 && !queuedAddrs.has(addr)) {
        borderlinePositions.push(borrower);
      }
    }

    // Sort borderline by HF (riskiest first)
    borderlinePositions.sort((a, b) => a.healthFactor - b.healthFactor);

    // Take top positions from priority queue
    const priorityList = this.priorityQueue.getAll().slice(0, this.settings.priorityCheckCount);
    const borderlineSample = borderlinePositions.slice(0, 20);

    // MERGE: priority queue + at-risk list + borderline (deduplicated)
    const seenAddrs = new Set();
    const toCheck = [];

    // 1. Add all at-risk positions FIRST (must always be rechecked!)
    for (const pos of this.atRiskPositions) {
      const addr = pos.address?.toLowerCase();
      if (addr && !seenAddrs.has(addr)) {
        seenAddrs.add(addr);
        toCheck.push(pos);
      }
    }

    // 2. Add priority queue (if not already in at-risk)
    for (const pos of priorityList) {
      const addr = pos.address?.toLowerCase();
      if (addr && !seenAddrs.has(addr)) {
        seenAddrs.add(addr);
        toCheck.push(pos);
      }
    }

    // 3. Add borderline sample (if not already added)
    for (const pos of borderlineSample) {
      const addr = pos.address?.toLowerCase();
      if (addr && !seenAddrs.has(addr)) {
        seenAddrs.add(addr);
        toCheck.push(pos);
      }
    }

    // 4. ROTATION SWEEP — the fix for "always looking at the same items".
    //    Add a rotating window over the ENTIRE borrower population so every
    //    position gets re-priced on a fixed cadence, regardless of its last
    //    known HF. A position that was healthy a minute ago and just crossed
    //    the line is caught here; the old code would never have looked.
    let rotationAdded = 0;
    const allAddrs = [...this.borrowers.keys()];
    if (allAddrs.length > 0) {
      const win = Math.min(this.rotationWindow, allAddrs.length);
      for (let i = 0; i < win; i++) {
        const addr = allAddrs[(this.rotationCursor + i) % allAddrs.length];
        if (!seenAddrs.has(addr)) {
          seenAddrs.add(addr);
          toCheck.push(this.borrowers.get(addr));
          rotationAdded++;
        }
      }
      this.rotationCursor = (this.rotationCursor + win) % allAddrs.length;
    }

    if (toCheck.length === 0) return;

    // Log what we're checking (helps debug)
    const fromAtRisk = toCheck.filter(p => atRiskAddresses.has(p.address?.toLowerCase())).length;
    const fromQueue = priorityList.length;
    const fromBorderline = borderlineSample.length;

    if (process.env.DEBUG_PRIORITY_CHECK === 'true') {
      console.log(`   ⚡ Priority check: ${toCheck.length} positions (at-risk: ${fromAtRisk}, queue: ${fromQueue}, borderline: ${fromBorderline})`);
    }

    let liquidatable = 0;
    let newAtRisk = 0;

    // Use MULTICALL for priority checks (1 RPC call for all!)
    const addresses = toCheck.map(b => b.address);
    const healthResults = await this.batchCheckAaveHealth(addresses);

    for (const borrower of toCheck) {
      const addr = borrower.address?.toLowerCase();
      const result = healthResults.get(addr);

      if (result) {
        // Update in main borrowers map
        if (this.borrowers.has(addr)) {
          const stored = this.borrowers.get(addr);
          stored.healthFactor = result.healthFactor;
          stored.totalDebtUSD = result.totalDebtUSD;
          stored.lastChecked = now;
        }

        borrower.healthFactor = result.healthFactor;
        borrower.totalDebtUSD = result.totalDebtUSD;
        borrower.lastChecked = now;

        // FIX #5: Add newly at-risk to priority queue (with deduplication!)
        if (result.healthFactor < this.settings.watchThreshold && result.healthFactor >= 1.0) {
          const inQueue = this.priorityQueue.getAll().find(p => p.address?.toLowerCase() === addr);
          if (!inQueue) {
            this.priorityQueue.enqueue({
              ...borrower,
              ...result,
            }, result.healthFactor);
          }

          // Add to at-risk list (riskier positions replace less risky ones)
          const addResult = this.addToAtRiskList({
            ...borrower,
            ...result,
          });
          if (addResult.added && !addResult.replaced) {
            newAtRisk++;
          }
        }

        // Check if now liquidatable (filter out HF=0 as invalid)
        if (result.healthFactor < 1.0 && result.healthFactor > 0.01) {
          // ADD TO LIQUIDATABLE immediately!
          const exists = this.liquidatablePositions.find(p => p.address?.toLowerCase() === addr);
          if (!exists) {
            const liqPos = {
              ...borrower,
              ...result,
            };
            this.liquidatablePositions.push(liqPos);
            // Save to cache for persistence
            if (this.useCache) {
              this.cache.addLiquidatable(liqPos);
            }
            liquidatable++;
            console.log(`   🎯 LIQUIDATABLE: ${borrower.address?.slice(0, 10)}... HF=${result.healthFactor.toFixed(4)}`);
          }
        }
      }
    }

    // Evict positions that have recovered comfortably above the watch
    // threshold. Without this, a position that dips to HF 1.05 then recovers
    // stays in the at-risk list forever and permanently burns bandwidth —
    // the root cause of the bot fixating on the same items.
    const evicted = this.pruneRecovered();

    // Sort liquidatable by HF
    this.liquidatablePositions.sort((a, b) => a.healthFactor - b.healthFactor);
    this.atRiskPositions.sort((a, b) => a.healthFactor - b.healthFactor);
    this.stats.liquidatableCount = this.liquidatablePositions.length;
    this.stats.atRiskCount = this.atRiskPositions.length;

    if (liquidatable > 0) {
      console.log(`   ⚡ Found ${liquidatable} new liquidatable position(s)!`);
    }
    if (newAtRisk > 0) {
      console.log(`   ⚠️ Found ${newAtRisk} newly at-risk position(s)!`);
    }

    // ALWAYS log priority check summary (confirms rotation + eviction are working)
    console.log(`   ✅ Priority check: ${toCheck.length} rechecked (rotation +${rotationAdded}, evicted ${evicted}) → ${this.atRiskPositions.length} at-risk, ${this.liquidatablePositions.length} liquidatable`);
  }

  /**
   * Stop monitoring
   */
  stop() {
    this.isRunning = false;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.priorityCheckTimer) clearInterval(this.priorityCheckTimer);
    if (this.liquidationCheckTimer) clearInterval(this.liquidationCheckTimer);
    if (this.wsHealthTimer) clearInterval(this.wsHealthTimer);

    // Save cache before stopping!
    if (this.useCache && this.borrowers.size > 0) {
      console.log(`   💾 Saving ${this.borrowers.size} borrowers to cache...`);
      this.syncToCache();
      this.cache.save();
    }

    // Cleanup event listeners
    for (const listener of this.eventListeners) {
      try {
        listener.removeAllListeners();
      } catch (e) {}
    }
    this.eventListeners = [];

    if (this.wsProvider) {
      try {
        this.wsProvider.destroy();
      } catch (e) {}
    }

    // Stop mempool monitor
    if (this.mempoolMonitor) {
      this.mempoolMonitor.stop();
    }

    console.log(`\n🛑 Health Monitor stopped`);
  }

  /**
   * Scan for borrowers using Subgraph (primary) or RPC events (fallback)
   * FIX #1: ALWAYS do incremental scan - new borrowers appear daily!
   */
  async scanForBorrowers() {
    const existingCount = this.borrowers.size;

    console.log(`\n🔍 Scanning for borrowers (have: ${existingCount}, limit: ${this.settings.maxBorrowers})...`);

    // FIX #1: Don't skip - always look for NEW borrowers even when cache is full
    // New people borrow every day, we need to track them!
    const isIncrementalMode = existingCount >= this.settings.maxBorrowers * 0.9;
    if (isIncrementalMode) {
      console.log(`   💾 Cache has ${existingCount} borrowers - incremental scan for NEW only`);
    }

    const beforeCount = this.borrowers.size;

    // PRIMARY: Use Subgraph if available
    if (this.useSubgraph && this.subgraphClient?.available) {
      await this.scanViaSubgraph();

      const newFound = this.borrowers.size - beforeCount;
      if (newFound > 0) {
        console.log(`   ✨ Found ${newFound} NEW borrowers via subgraph`);
      }

      // If subgraph got results, we're done
      if (this.borrowers.size > 0) {
        // Save to cache
        if (this.useCache) {
          this.syncToCache();
        }
        return;
      }

      console.log(`   ⚠️ Subgraph returned 0 borrowers, trying RPC fallback...`);
    }

    // FALLBACK: Use RPC event scanning
    await this.scanViaRPC();

    // If still no borrowers, seed with known addresses
    if (this.borrowers.size === 0) {
      await this.seedKnownBorrowers();
    }

    // Save to cache
    if (this.useCache && this.borrowers.size > 0) {
      this.syncToCache();
    }
  }

  /**
   * Sync in-memory borrowers to persistent cache
   */
  syncToCache() {
    if (!this.useCache) return;

    for (const [addr, data] of this.borrowers) {
      this.cache.set(addr, data);
    }
    this.cache.save();
  }

  /**
   * Scan borrowers via The Graph subgraph WITH PAGINATION for 5000+ borrowers
   */
  async scanViaSubgraph() {
    try {
      let totalFetched = 0;
      let newCount = 0;
      const batchSize = 1000;
      let hasMore = true;
      let skip = 0;

      while (hasMore && totalFetched < this.settings.maxBorrowers) {
        const limit = Math.min(batchSize, this.settings.maxBorrowers - totalFetched);

        const borrowers = await this.subgraphClient.fetchAllBorrowers({
          minDebtUSD: this.settings.minDebtUSD,
          maxDebtUSD: this.settings.maxDebtUSD,
          limit,
          skip,
        });

        for (const borrower of borrowers) {
          const addr = borrower.address?.toLowerCase();
          if (!addr) continue;

          // NOTE: The subgraph's totalDebtUSD is UNRELIABLE (not actually USD!)
          // Only use it as a "has ANY debt" indicator, not for amount filtering
          // Real filtering happens AFTER we check on-chain
          const hasAnyDebt = borrower.borrowedReservesCount > 0 ||
                            (borrower.debts && borrower.debts.length > 0);

          // Check if this was previously marked "closed" but now has debt again
          const wasClosed = this.useCache && this.cache.isClosed(addr);

          if (wasClosed && hasAnyDebt) {
            // REACTIVATE - they borrowed again!
            // NOTE: subgraph totalDebtUSD is not reliable, so don't show it
            this.cache.reactivate(addr);
            console.log(`   🔄 Reactivated ${addr.slice(0, 10)}... (has ${borrower.debts?.length || 0} debt position(s))`);
          } else if (wasClosed) {
            // Still closed according to subgraph, skip
            continue;
          }

          if (!this.borrowers.has(addr)) {
            this.borrowers.set(addr, {
              address: borrower.address,
              protocol: borrower.protocol,
              protocolType: borrower.protocolType,
              lastChecked: 0,
              healthFactor: null, // MUST check on-chain
              totalDebtUSD: null, // MUST check on-chain (subgraph value is unreliable)
              totalCollateralUSD: null,
              debts: borrower.debts || [],
            });
            newCount++;
          }
        }

        totalFetched += borrowers.length;
        skip += batchSize;

        // Stop if we got fewer than requested (no more data)
        if (borrowers.length < limit) {
          hasMore = false;
        }

        // Small delay between paginated requests
        if (hasMore) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      this.stats.scansCompleted++;
      this.stats.lastScanTime = Date.now();
      this.stats.totalBorrowersTracked = this.borrowers.size;

      console.log(`   ✅ Subgraph: ${newCount} new borrowers (total: ${this.borrowers.size})`);

      // Show protocols found
      const protocols = new Map();
      for (const b of this.borrowers.values()) {
        const p = b.protocol || 'UNKNOWN';
        protocols.set(p, (protocols.get(p) || 0) + 1);
      }

      if (protocols.size > 0) {
        const summary = Array.from(protocols.entries())
          .map(([p, count]) => `${p}: ${count}`)
          .join(', ');
        console.log(`   📊 By protocol: ${summary}`);
      }

    } catch (error) {
      console.error(`   ❌ Subgraph scan error: ${error.message}`);
    }
  }

  /**
   * Scan borrowers via RPC events (fallback when subgraph is unavailable)
   */
  async scanViaRPC() {
    try {
      this.trackRpcCall(1); // getBlockNumber
      const currentBlock = await this.provider.getBlockNumber();

      // Use larger lookback for more borrowers
      const blocksPerScan = {
        POLYGON: 2000,
        ARBITRUM: 10000,
        BASE: 5000,
        BSC: 3000,
        AVALANCHE: 5000,
      };
      const lookback = blocksPerScan[this.chain.name?.toUpperCase()] || 2000;
      const fromBlock = Math.max(0, currentBlock - lookback);

      console.log(`   📡 RPC fallback: Scanning blocks ${fromBlock} - ${currentBlock}...`);

      let newBorrowers = 0;

      // Scan Aave V3 Borrow events in chunks
      if (this.aavePool) {
        const chunkSize = 500;
        for (let start = fromBlock; start < currentBlock; start += chunkSize) {
          const end = Math.min(start + chunkSize - 1, currentBlock);

          try {
            const borrowFilter = this.aavePool.filters.Borrow();
            this.trackRpcCall(1); // queryFilter
            const events = await this.aavePool.queryFilter(borrowFilter, start, end);

            for (const event of events) {
              const borrower = event.args?.onBehalfOf || event.args?.user;
              const addr = borrower?.toLowerCase();

              // FIX: Skip closed positions - don't re-add them!
              if (this.useCache && this.cache.isClosed(addr)) {
                continue;
              }

              if (addr && !this.borrowers.has(addr)) {
                this.borrowers.set(addr, {
                  address: borrower,
                  protocol: 'AAVE_V3',
                  lastChecked: 0,
                  healthFactor: null,
                  totalDebtUSD: null,
                  totalCollateralUSD: null,
                });
                newBorrowers++;
              }
            }
          } catch (err) {
            // Rate limit - take a break
            if (err.message?.includes('-32062') || err.message?.includes('rate')) {
              await new Promise(r => setTimeout(r, 1000));
            }
          }

          // Small delay between chunks
          await new Promise(r => setTimeout(r, 100));
        }
      }

      this.stats.scansCompleted++;
      this.stats.lastScanTime = Date.now();
      this.stats.totalBorrowersTracked = this.borrowers.size;

      if (newBorrowers > 0) {
        console.log(`   ✅ RPC: Found ${newBorrowers} new borrowers (total: ${this.borrowers.size})`);
      }

    } catch (error) {
      console.error(`   ❌ RPC scan error: ${error.message}`);
    }
  }

  /**
   * Seed with known active borrowers
   */
  async seedKnownBorrowers() {
    console.log(`   📡 Seeding with known borrower addresses...`);

    const knownBorrowers = {
      POLYGON: [
        '0x8dF3aad3a84da6b69A4DA8aeC3eA40d9091B2Ac4',
        '0x0c54a0BCCF5079478a144dBae1AFcb4FEdf7b263',
        '0x57E04786E231Af3343562C062E0d058F25daCE9E',
        '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
      ],
      ARBITRUM: [
        '0x8dF3aad3a84da6b69A4DA8aeC3eA40d9091B2Ac4',
        '0x489ee077994B6658eAfA855C308275EAd8097C4A',
      ],
      BASE: [
        '0x8dF3aad3a84da6b69A4DA8aeC3eA40d9091B2Ac4',
      ],
      AVALANCHE: [
        '0x8dF3aad3a84da6b69A4DA8aeC3eA40d9091B2Ac4',
      ],
    };

    const chainAddresses = knownBorrowers[this.chain.name?.toUpperCase()] || [];

    if (chainAddresses.length === 0) {
      console.log(`   ℹ️ No seed addresses configured for ${this.chain.name}`);
      return;
    }

    let validCount = 0;

    for (const address of chainAddresses) {
      try {
        if (this.aavePool) {
          this.trackRpcCall(1); // getUserAccountData
          const data = await this.aavePool.getUserAccountData(address);
          const totalDebt = parseFloat(ethers.formatUnits(data.totalDebtBase, 8));

          if (totalDebt >= this.settings.minDebtUSD) {
            this.borrowers.set(address.toLowerCase(), {
              address,
              protocol: 'AAVE_V3',
              lastChecked: Date.now(),
              healthFactor: parseFloat(ethers.formatEther(data.healthFactor)),
              totalDebtUSD: totalDebt,
              totalCollateralUSD: parseFloat(ethers.formatUnits(data.totalCollateralBase, 8)),
            });
            validCount++;
          }
        }
      } catch (err) {}

      await new Promise(r => setTimeout(r, 100));
    }

    if (validCount > 0) {
      console.log(`   ✅ Seeded ${validCount} verified borrowers`);
    }

    this.stats.totalBorrowersTracked = this.borrowers.size;
  }

  /**
   * Check health factors for tracked borrowers
   * SMART: Only checks borrowers that need checking (not all 5000!)
   * FIXES: #2 Dynamic limit, #3 Merge queue, #4 Prioritize null HF
   */
  async checkAllHealthFactors() {
    if (this.borrowers.size === 0) return;

    // Clean up invalid positions (HF=0) at the start of each cycle
    this.cleanupInvalidPositions();

    const now = Date.now();
    const batchSize = 50;

    // SMART FILTERING with ROTATION:
    // 1. Always check at-risk positions (HF < watchThreshold)
    // 2. Check positions with null HF (never checked)
    // 3. ROTATE through all other positions to ensure complete coverage
    //
    // This ensures we cycle through ALL borrowers, not just the same ones

    const atRiskToCheck = [];      // HF < threshold - ALWAYS check
    const nullHfPositions = [];     // Never checked - HIGH priority
    const stalePositions = [];      // Not checked in a while
    const recentPositions = [];     // Recently checked but need rotation

    // Shorter freshness window to enable faster rotation
    const freshAgeMs = 45000; // 45 seconds (was 60s)

    for (const [addr, borrower] of this.borrowers) {
      const age = now - (borrower.lastChecked || 0);
      const hasNullHf = borrower.healthFactor === null || borrower.healthFactor === undefined;
      const isRisky = borrower.healthFactor && borrower.healthFactor < this.settings.watchThreshold;

      if (hasNullHf) {
        nullHfPositions.push(borrower);
      } else if (isRisky) {
        atRiskToCheck.push(borrower);
      } else if (!borrower.lastChecked || age > freshAgeMs) {
        stalePositions.push(borrower);
      } else {
        recentPositions.push(borrower);
      }
    }

    // Sort at-risk by HF (riskiest first)
    atRiskToCheck.sort((a, b) => a.healthFactor - b.healthFactor);

    // Sort stale by oldest first (ensures rotation)
    stalePositions.sort((a, b) => (a.lastChecked || 0) - (b.lastChecked || 0));

    // Sort recent by oldest first too (for rotation when we have capacity)
    recentPositions.sort((a, b) => (a.lastChecked || 0) - (b.lastChecked || 0));

    // Build check list with priorities:
    // 1. Null HF (never checked) - MUST check
    // 2. At-risk positions - MUST check
    // 3. Stale positions - fill remaining slots
    // 4. Recent positions - include some for rotation (catch rapid changes)

    const baseLimit = 1000;
    const rotationBonus = 500; // Extra slots for rotation through "recent" positions
    const dynamicLimit = baseLimit + Math.min(nullHfPositions.length, 500) + rotationBonus;

    const checkList = [];

    // Priority 1: Null HF
    checkList.push(...nullHfPositions);

    // Priority 2: At-risk
    checkList.push(...atRiskToCheck);

    // Priority 3: Stale (oldest first)
    const remainingSlots = dynamicLimit - checkList.length;
    if (remainingSlots > 0) {
      // Split remaining between stale and rotation
      const staleSlots = Math.floor(remainingSlots * 0.7); // 70% for stale
      const rotationSlots = remainingSlots - staleSlots;    // 30% for rotation

      checkList.push(...stalePositions.slice(0, staleSlots));
      checkList.push(...recentPositions.slice(0, rotationSlots));
    }

    // Log rotation stats (helps debug)
    const skipped = this.borrowers.size - checkList.length;
    const staleChecked = checkList.filter(b => stalePositions.includes(b)).length;
    const rotationChecked = checkList.filter(b => recentPositions.includes(b)).length;

    console.log(`   📊 Health Check: ${checkList.length}/${this.borrowers.size} to check`);
    console.log(`      ├─ Null HF (new): ${nullHfPositions.length}`);
    console.log(`      ├─ At-risk: ${atRiskToCheck.length}`);
    console.log(`      ├─ Stale: ${staleChecked}`);
    console.log(`      └─ Rotation: ${rotationChecked}`)

    // FIX #3: DON'T clear priority queue fully - preserve recent data
    // Only clear if it's been fully rebuilt recently
    const existingAtRisk = this.priorityQueue.getAll();
    const recentAtRisk = existingAtRisk.filter(p => {
      const age = now - (p.lastChecked || 0);
      return age < 30000; // Keep positions checked in last 30s
    });

    // Rebuild queue, starting with preserved recent positions
    this.priorityQueue.clear();
    for (const pos of recentAtRisk) {
      this.priorityQueue.enqueue(pos, pos.healthFactor);
    }

    // DON'T reset atRiskPositions - just remove stale entries
    // This prevents "Found X newly at-risk" spam
    const staleCutoff = now - 120000; // 2 minutes
    this.atRiskPositions = this.atRiskPositions.filter(p => {
      const lastCheck = p.lastChecked || 0;
      return lastCheck > staleCutoff;
    });

    // Clear stale liquidatable positions
    const freshCutoff = Date.now() - 60000;
    this.liquidatablePositions = this.liquidatablePositions.filter(
      p => (p.lastChecked || 0) > freshCutoff
    );

    let checkedCount = 0;
    let closedCount = 0;
    let errorCount = 0;   // RPC errors (null results)
    let lowDebtCount = 0; // Debt below minDebtUSD
    let highDebtCount = 0; // Debt above maxDebtUSD

    // Use larger batch for multicall (100 users = 1 RPC call!)
    const multicallBatchSize = this.settings.multicallBatchSize || 100;

    // Process in batches using MULTICALL (dramatic RPC reduction!)
    for (let i = 0; i < checkList.length; i += multicallBatchSize) {
      const batch = checkList.slice(i, i + multicallBatchSize);
      const addresses = batch.map(b => b.address);

      // ONE RPC call for entire batch!
      const healthResults = await this.batchCheckAaveHealth(addresses);

      // Process results
      for (const borrower of batch) {
        const addr = borrower.address?.toLowerCase();
        const result = healthResults.get(addr);
        checkedCount++;

        // Handle missing result (RPC error) - DON'T delete, just skip this cycle
        if (!result) {
          errorCount++;
          continue;
        }

        // Position truly closed (debt < $1) - mark and remove
        if (result.totalDebtUSD < 1) {
          if (this.useCache) {
            this.cache.markClosed(borrower.address);
          }
          this.borrowers.delete(addr);
          closedCount++;
          continue;
        }

        // Update borrower data
        borrower.healthFactor = result.healthFactor;
        borrower.totalDebtUSD = result.totalDebtUSD;
        borrower.totalCollateralUSD = result.totalCollateralUSD;
        borrower.lastChecked = now;

        // Check if within our target range
        const belowMin = result.totalDebtUSD < this.settings.minDebtUSD;
        const aboveMax = result.totalDebtUSD > this.settings.maxDebtUSD;

        if (belowMin) {
          lowDebtCount++;
          continue;
        }

        if (aboveMax) {
          highDebtCount++;
          continue;
        }

        // Add to priority queue if at-risk (with deduplication! Filter HF=0)
        if (result.healthFactor < this.settings.watchThreshold && result.healthFactor > 0.01) {
          // Check if already in queue
          const inQueue = this.priorityQueue.getAll().find(p => p.address?.toLowerCase() === addr);
          if (!inQueue) {
            this.priorityQueue.enqueue({
              ...borrower,
              ...result,
            }, result.healthFactor);
          }

          // Add to at-risk list (riskier positions replace less risky ones)
          this.addToAtRiskList({
            ...borrower,
            ...result,
          });
        }

        // Track liquidatable positions
        // FIX: Filter out HF=0 (invalid/closed) and HF<0.01 (suspicious data)
        if (result.healthFactor < 1.0 && result.healthFactor > 0.01) {
          const exists = this.liquidatablePositions.find(
            p => p.address?.toLowerCase() === addr
          );
          if (!exists) {
            const liqPos = {
              ...borrower,
              ...result,
            };
            this.liquidatablePositions.push(liqPos);
            // Save to cache for persistence across restarts
            if (this.useCache) {
              this.cache.addLiquidatable(liqPos);
            }
          }
        }
      }

      // Small delay between multicall batches
      if (i + multicallBatchSize < checkList.length) {
        await new Promise(r => setTimeout(r, 50));
      }
    }

    // Sort at-risk by health factor
    this.atRiskPositions.sort((a, b) => a.healthFactor - b.healthFactor);
    this.liquidatablePositions.sort((a, b) => a.healthFactor - b.healthFactor);

    // Update stats
    this.stats.atRiskCount = this.atRiskPositions.length;
    this.stats.liquidatableCount = this.liquidatablePositions.length;
    this.stats.totalBorrowersTracked = this.borrowers.size;

    // Save to cache periodically
    if (this.useCache && checkedCount > 0) {
      this.syncToCache();
    }

    // Log summary with breakdown
    const outOfRangeTotal = lowDebtCount + highDebtCount;
    console.log(`   ✅ Checked: ${checkedCount} | Closed: ${closedCount} | Out of range: ${outOfRangeTotal} | Errors: ${errorCount}`);

    // ALWAYS show debt range filter if at-risk positions were filtered out
    if (outOfRangeTotal > 0) {
      console.log(`   ⚠️ ${outOfRangeTotal} AT-RISK positions filtered by debt range!`);
      console.log(`      └─ Below $${this.settings.minDebtUSD}: ${lowDebtCount} | Above $${this.settings.maxDebtUSD}: ${highDebtCount}`);
      console.log(`      💡 Adjust MIN_DEBT_USD / MAX_DEBT_USD in .env to include them`);
    }
    console.log(`   🔄 Queue preserved: ${recentAtRisk.length} recent at-risk positions`);

    console.log(`   🎯 At-risk: ${this.stats.atRiskCount} | Liquidatable: ${this.stats.liquidatableCount}`);

    if (this.priorityQueue.length > 0) {
      const top = this.priorityQueue.peek();
      console.log(`   ⚡ Riskiest: ${top?.address?.slice(0, 10)}... HF=${top?.healthFactor?.toFixed(4)} Debt=$${top?.totalDebtUSD?.toFixed(0)}`);
    }

    // DIAGNOSTIC: Show HF distribution if no at-risk found
    if (this.stats.atRiskCount === 0 && checkedCount > 0) {
      // Collect HF values from all borrowers
      const hfValues = [];
      for (const b of this.borrowers.values()) {
        if (b.healthFactor && b.healthFactor > 0.01 && b.healthFactor < 100) {
          hfValues.push(b.healthFactor);
        }
      }

      if (hfValues.length > 0) {
        hfValues.sort((a, b) => a - b);
        const min = hfValues[0];
        const max = hfValues[hfValues.length - 1];
        const median = hfValues[Math.floor(hfValues.length / 2)];
        const belowThreshold = hfValues.filter(hf => hf < this.settings.watchThreshold).length;

        console.log(`\n   📊 HF DISTRIBUTION (${hfValues.length} positions):`);
        console.log(`      Min: ${min.toFixed(4)} | Median: ${median.toFixed(2)} | Max: ${max.toFixed(2)}`);
        console.log(`      Below ${this.settings.watchThreshold}: ${belowThreshold}`);
        console.log(`      💡 If Min > ${this.settings.watchThreshold}, increase WATCH_THRESHOLD in .env`);
      }
    }
  }

  /**
   * Check health factor for a single borrower
   */
  async checkBorrowerHealth(borrower) {
    const protocol = borrower.protocol?.toUpperCase();

    if (['AAVE_V3', 'RADIANT', 'SEAMLESS'].includes(protocol) && this.aavePool) {
      return await this.checkAaveHealth(borrower.address);
    }

    if (protocol === 'VENUS' && this.venusComptroller) {
      return await this.checkVenusHealth(borrower.address);
    }

    if (['MOONWELL', 'BENQI', 'COMPOUND_V3'].includes(protocol)) {
      if (borrower.healthFactor !== null) {
        return {
          healthFactor: borrower.healthFactor,
          totalDebtUSD: borrower.totalDebtUSD || 0,
          totalCollateralUSD: borrower.totalCollateralUSD || 0,
          protocol: protocol,
          protocolType: PROTOCOL_TYPES[protocol] || 0,
        };
      }
    }

    return null;
  }

  /**
   * Check Aave V3 health factor
   */
  async checkAaveHealth(userAddress) {
    try {
      this.trackRpcCall(1); // Track individual RPC call
      const data = await this.aavePool.getUserAccountData(userAddress);

      const totalCollateralUSD = parseFloat(ethers.formatUnits(data.totalCollateralBase, 8));
      const totalDebtUSD = parseFloat(ethers.formatUnits(data.totalDebtBase, 8));
      const healthFactor = parseFloat(ethers.formatEther(data.healthFactor));

      if (totalDebtUSD < 1) return null;

      return {
        healthFactor,
        totalDebtUSD,
        totalCollateralUSD,
        liquidationThreshold: Number(data.currentLiquidationThreshold) / 100,
        ltv: Number(data.ltv) / 100,
        protocol: 'AAVE_V3',
        protocolType: PROTOCOL_TYPES.AAVE_V3,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * BATCHED Aave health check - check users in batched RPC calls!
   * Returns Map<address, healthResult>
   */
  async batchCheckAaveHealth(userAddresses) {
    if (!this.aavePool || userAddresses.length === 0) {
      return new Map();
    }

    const results = new Map();
    const poolAddress = this.aavePool.target || this.aavePool.address;
    const batchSize = this.settings.multicallBatchSize || 50; // Use setting!

    // Split into batches to avoid RPC overload
    for (let i = 0; i < userAddresses.length; i += batchSize) {
      const batch = userAddresses.slice(i, i + batchSize);

      try {
        // Track as 1 RPC call per batch
        this.trackRpcCall(1, true);

        const batchResults = await this.multicall.batchGetAaveHealthFactors(
          poolAddress,
          batch,
          AAVE_POOL_ABI
        );

        for (const result of batchResults) {
          if (result.error) {
            results.set(result.user.toLowerCase(), null);
            continue;
          }

          const totalCollateralUSD = parseFloat(ethers.formatUnits(result.totalCollateralBase || 0n, 8));
          const totalDebtUSD = parseFloat(ethers.formatUnits(result.totalDebtBase || 0n, 8));
          const healthFactor = parseFloat(ethers.formatEther(result.healthFactor || 0n));

          // Return ALL results (even low debt) so caller can decide what to do
          results.set(result.user.toLowerCase(), {
            healthFactor,
            totalDebtUSD,
            totalCollateralUSD,
            liquidationThreshold: Number(result.currentLiquidationThreshold || 0) / 100,
            ltv: Number(result.ltv || 0) / 100,
            protocol: 'AAVE_V3',
            protocolType: PROTOCOL_TYPES.AAVE_V3,
          });
        }
      } catch (error) {
        // This batch failed - mark as null (will be retried next cycle)
        for (const addr of batch) {
          results.set(addr.toLowerCase(), null);
        }
      }

      // Small delay between batches to avoid rate limits
      if (i + batchSize < userAddresses.length) {
        await new Promise(r => setTimeout(r, 50));
      }
    }

    return results;
  }

  /**
   * Check Venus health
   */
  async checkVenusHealth(userAddress) {
    try {
      this.trackRpcCall(1); // Track individual RPC call
      const [error, liquidity, shortfall] = await this.venusComptroller.getAccountLiquidity(userAddress);

      if (error !== 0n) return null;

      const shortfallUSD = parseFloat(ethers.formatEther(shortfall));
      const liquidityUSD = parseFloat(ethers.formatEther(liquidity));

      let healthFactor;
      if (shortfallUSD > 0) {
        healthFactor = 0.95;
      } else if (liquidityUSD > 0) {
        healthFactor = 1.5;
      } else {
        healthFactor = 1.0;
      }

      return {
        healthFactor,
        totalDebtUSD: shortfallUSD > 0 ? shortfallUSD : 0,
        totalCollateralUSD: liquidityUSD,
        shortfall: shortfallUSD,
        liquidity: liquidityUSD,
        protocol: 'VENUS',
        protocolType: PROTOCOL_TYPES.VENUS,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Remove broken/invalid positions (HF=0, already liquidated, etc.)
   * Call this periodically to clean up stale data
   */
  cleanupInvalidPositions() {
    let removed = 0;

    // Remove from atRiskPositions
    const validAtRisk = [];
    for (const pos of this.atRiskPositions) {
      if (pos.healthFactor <= 0.01 || !pos.healthFactor) {
        // Mark as closed so it won't be re-added
        if (this.useCache && pos.address) {
          this.cache.markClosed(pos.address);
        }
        removed++;
      } else {
        validAtRisk.push(pos);
      }
    }
    this.atRiskPositions = validAtRisk;

    // Remove from liquidatablePositions
    const validLiq = [];
    for (const pos of this.liquidatablePositions) {
      if (pos.healthFactor <= 0.01 || !pos.healthFactor) {
        if (this.useCache && pos.address) {
          this.cache.markClosed(pos.address);
          this.cache.removeLiquidatable(pos.address);
        }
        removed++;
      } else {
        validLiq.push(pos);
      }
    }
    this.liquidatablePositions = validLiq;

    // Remove from priorityQueue
    const queuePositions = this.priorityQueue.getAll();
    this.priorityQueue.clear();
    for (const pos of queuePositions) {
      if (pos.healthFactor > 0.01 && pos.healthFactor) {
        this.priorityQueue.enqueue(pos, pos.healthFactor);
      } else {
        if (this.useCache && pos.address) {
          this.cache.markClosed(pos.address);
        }
        removed++;
      }
    }

    // Remove from main borrowers map
    for (const [addr, borrower] of this.borrowers) {
      if (borrower.healthFactor !== null && borrower.healthFactor <= 0.01) {
        this.borrowers.delete(addr);
        if (this.useCache) {
          this.cache.markClosed(addr);
        }
        removed++;
      }
    }

    // Also purge from cache
    if (this.useCache) {
      removed += this.cache.purgeInvalidPositions();
    }

    if (removed > 0) {
      console.log(`   🧹 Cleaned up ${removed} invalid positions (HF=0)`);
    }

    return removed;
  }

  /**
   * Get liquidatable positions ready for execution
   */
  getLiquidatablePositions() {
    // Filter requirements for a PROFITABLE liquidation:
    // 1. HF > 0.01 (not already fully liquidated)
    // 2. HF < 1.0 (actually liquidatable)
    // 3. Debt > minDebtUSD (profitable after gas)
    const minDebt = this.settings.minDebtUSD || 50;

    return this.liquidatablePositions.filter(p =>
      p.healthFactor > 0.01 &&
      p.healthFactor < 1.0 &&
      p.totalDebtUSD >= minDebt
    );
  }

  /**
   * Get at-risk positions (deduplicated and filtered)
   */
  getAtRiskPositions() {
    // Deduplicate by address and filter out:
    // - Invalid HF (0 or null)
    // - Dust positions (very low HF + tiny debt = already liquidated)
    const seen = new Set();
    const minDebt = this.settings.minDebtUSD || 50;

    return this.atRiskPositions.filter(p => {
      const addr = p.address?.toLowerCase();
      if (!addr) return false;
      if (seen.has(addr)) return false;
      if (p.healthFactor <= 0.01) return false; // Filter HF=0

      // Filter dust: if HF < 0.5 but debt < minDebt, it's likely already-liquidated dust
      if (p.healthFactor < 0.5 && p.totalDebtUSD < minDebt) {
        return false;
      }

      seen.add(addr);
      return true;
    });
  }

  /**
   * Get priority queue positions (riskiest)
   */
  getPriorityPositions() {
    return this.priorityQueue.getAll();
  }

  /**
   * Get stats
   */
  getStats() {
    const byProtocol = {};
    for (const b of this.borrowers.values()) {
      const p = b.protocol || 'UNKNOWN';
      byProtocol[p] = (byProtocol[p] || 0) + 1;
    }

    // Update per-minute counter if needed
    const now = Date.now();
    if (now - this.stats.lastMinuteReset >= 60000) {
      this.stats.rpcCallsLastMinute = this.stats.rpcCallsThisMinute;
      this.stats.rpcCallsThisMinute = 0;
      this.stats.lastMinuteReset = now;
    }

    return {
      ...this.stats,
      borrowersTracked: this.borrowers.size,
      priorityQueueSize: this.priorityQueue.length,
      byProtocol,
      usingSubgraph: this.useSubgraph && this.subgraphClient !== null,
      hasWebSocket: this.wsProvider !== null,
      hasMempool: this.mempoolMonitor !== null && this.mempoolMonitor.isRunning,
      subgraphStats: this.subgraphClient?.getStats() || null,
      mempoolStats: this.mempoolMonitor?.getStats() || null,
      // RPC stats
      rpcStats: {
        totalCalls: this.stats.rpcCalls,
        multicallBatches: this.stats.multicallBatches,
        callsPerMinute: this.stats.rpcCallsLastMinute || this.stats.rpcCallsThisMinute,
      },
    };
  }

  /**
   * Add a specific borrower to track
   */
  addBorrower(address, protocol = 'AAVE_V3') {
    const addrLower = address.toLowerCase();
    if (!this.borrowers.has(addrLower)) {
      this.borrowers.set(addrLower, {
        address,
        protocol,
        lastChecked: 0,
        healthFactor: null,
        totalDebtUSD: null,
        totalCollateralUSD: null,
      });
      return true;
    }
    return false;
  }

  /**
   * Remove a borrower from tracking
   */
  removeBorrower(address) {
    const addr = address?.toLowerCase();
    if (!addr) return false;

    // Mark as closed in cache so it won't be re-added
    if (this.useCache) {
      this.cache.markClosed(addr);
    }

    return this.borrowers.delete(addr);
  }

  /**
   * Remove a position from liquidatable tracking
   */
  removeLiquidatable(address) {
    const addr = address?.toLowerCase();
    if (!addr) return false;

    // Remove from liquidatable array
    const idx = this.liquidatablePositions.findIndex(p => p.address?.toLowerCase() === addr);
    if (idx >= 0) {
      this.liquidatablePositions.splice(idx, 1);
    }

    // Remove from at-risk array
    const atRiskIdx = this.atRiskPositions.findIndex(p => p.address?.toLowerCase() === addr);
    if (atRiskIdx >= 0) {
      this.atRiskPositions.splice(atRiskIdx, 1);
    }

    // Remove from priority queue (rebuild without this address)
    const queuePositions = this.priorityQueue.getAll().filter(p => p.address?.toLowerCase() !== addr);
    this.priorityQueue.clear();
    for (const pos of queuePositions) {
      this.priorityQueue.enqueue(pos, pos.healthFactor);
    }

    // Remove from cache
    if (this.useCache) {
      this.cache.removeLiquidatable(addr);
    }

    return true;
  }
}

module.exports = HealthMonitor;
