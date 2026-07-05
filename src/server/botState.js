/**
 * BotState - central real-time state store for the dashboard.
 *
 * The bot writes snapshots/events here; the dashboard server subscribes and
 * streams typed messages to browsers over SSE. Designed to be a passive
 * observer: nothing here can affect liquidation logic, so it is safe to fail.
 *
 * Emits a single 'sse' event with { type, data } payloads:
 *   - 'snapshot' : full state (sent on each bot main-loop tick)
 *   - 'status'   : status/config patch
 *   - 'event'    : a liquidation attempt result
 *   - 'log'      : one captured console line
 */

const EventEmitter = require('events');

class BotState extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);

    const now = Date.now();
    this.startTime = now;

    this.state = {
      status: {
        running: false,
        dryRun: false,
        chain: null,
        chainId: null,
        wallet: null,
        walletShort: null,
        balanceNative: 0,
        nativeToken: 'POL',
        contractAddress: null,
        contractShort: null,
        startTime: now,
        lastUpdate: now,
        version: '2.0.0',
      },
      config: {
        minProfitUSD: 0,
        maxGasUSD: 0,
        minDebtUSD: 0,
        maxDebtUSD: 0,
        watchThreshold: 0,
        mevEnabled: false,
        slippagePercent: 1,
      },
      connection: {
        wss: false,
        mempool: false,
        subgraph: false,
        rpcCallsTotal: 0,
        rpcCallsPerMin: 0,
        multicallBatches: 0,
      },
      stats: {
        borrowersTracked: 0,
        atRiskCount: 0,
        liquidatableCount: 0,
        liquidationsAttempted: 0,
        liquidationsSuccessful: 0,
        liquidationsFailed: 0,
        successRate: 0,
        totalProfitUSD: 0,
        totalGasSpentUSD: 0,
        netProfitUSD: 0,
        mempoolOracleUpdates: 0,
        oraclesWatched: 0,
      },
      positions: {
        atRisk: [],       // [{ address, healthFactor, totalDebtUSD, protocol }]
        liquidatable: [],
      },
      events: [],          // liquidation attempts (most recent first)
      profitHistory: [],   // [{ ts, cumulative }] sampled each tick
      logs: [],            // recent console lines (most recent last)
    };

    this.maxEvents = 100;
    this.maxLogs = 400;
    this.maxProfitPoints = 720; // ~12h at 60s ticks
  }

  /** Merge a patch into status and broadcast. */
  patchStatus(patch = {}) {
    Object.assign(this.state.status, patch);
    this.state.status.lastUpdate = Date.now();
    this._broadcast('status', { status: this.state.status });
  }

  /** Set configuration (once at startup). */
  setConfig(config = {}) {
    Object.assign(this.state.config, config);
    this._broadcast('status', { config: this.state.config });
  }

  /**
   * Update the live snapshot from the bot's main loop. Accepts partial
   * sections; missing sections are left unchanged.
   */
  updateSnapshot({ status, connection, stats, positions } = {}) {
    if (status) Object.assign(this.state.status, status);
    if (connection) Object.assign(this.state.connection, connection);
    if (stats) Object.assign(this.state.stats, stats);
    if (positions) {
      if (positions.atRisk) this.state.positions.atRisk = positions.atRisk;
      if (positions.liquidatable) this.state.positions.liquidatable = positions.liquidatable;
    }

    // Derived
    const s = this.state.stats;
    s.netProfitUSD = (s.totalProfitUSD || 0) - (s.totalGasSpentUSD || 0);

    // Sample cumulative profit for the timeline chart
    this._recordProfitPoint(s.totalProfitUSD || 0);

    this.state.status.lastUpdate = Date.now();
    this._broadcast('snapshot', this.getState());
  }

  /** Record a liquidation attempt result. */
  pushEvent(evt) {
    const record = {
      ts: Date.now(),
      success: !!evt.success,
      simulated: !!evt.simulated,
      profit: evt.profit ?? null,
      gasSpent: evt.gasSpent ?? null,
      txHash: evt.txHash || null,
      reason: evt.reason || null,
      borrower: evt.borrower || null,
      healthFactor: evt.healthFactor ?? null,
      debtUSD: evt.debtUSD ?? null,
    };
    this.state.events.unshift(record);
    if (this.state.events.length > this.maxEvents) {
      this.state.events.length = this.maxEvents;
    }
    this._broadcast('event', record);
    return record;
  }

  /** Capture one console line. level: 'info' | 'warn' | 'error' | 'success'. */
  pushLog(level, msg) {
    const line = { ts: Date.now(), level: level || 'info', msg: String(msg) };
    this.state.logs.push(line);
    if (this.state.logs.length > this.maxLogs) {
      this.state.logs.splice(0, this.state.logs.length - this.maxLogs);
    }
    this._broadcast('log', line);
  }

  _recordProfitPoint(cumulative) {
    const hist = this.state.profitHistory;
    const last = hist[hist.length - 1];
    // Avoid duplicate flat points spamming the array; keep cadence but dedupe
    if (last && last.cumulative === cumulative && hist.length > 2) {
      last.ts = Date.now();
      return;
    }
    hist.push({ ts: Date.now(), cumulative });
    if (hist.length > this.maxProfitPoints) hist.shift();
  }

  /** Full state with a computed uptime, for initial page load. */
  getState() {
    return {
      ...this.state,
      status: {
        ...this.state.status,
        uptimeMs: Date.now() - this.startTime,
      },
    };
  }

  _broadcast(type, data) {
    try {
      this.emit('sse', { type, data });
    } catch (_) {
      // never let a subscriber error affect the bot
    }
  }
}

// Singleton - shared across the bot process
module.exports = new BotState();
