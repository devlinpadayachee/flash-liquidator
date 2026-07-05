/**
 * Price Monitor
 *
 * Tracks token prices and detects rapid price movements.
 * Price drops = liquidation opportunities!
 */

const { ethers } = require('ethers');
const { AAVE_ORACLE_ABI } = require('../config/protocols');

class PriceMonitor {
  constructor(chainConfig, provider) {
    this.chain = chainConfig;
    this.provider = provider;

    // Price history for detecting movements
    this.priceHistory = new Map(); // token -> [{ price, timestamp }, ...]
    this.historyLength = 60; // Keep last 60 data points

    // Current prices
    this.currentPrices = new Map();

    // Alert thresholds
    this.settings = {
      alertDropPercent: parseFloat(process.env.PRICE_DROP_ALERT || '5'), // Alert on 5%+ drop
      checkIntervalMs: parseInt(process.env.PRICE_CHECK_INTERVAL || '30') * 1000,
    };

    // Oracle contract
    this.oracle = null;

    // Callbacks
    this.onPriceDrop = null;

    // Stats
    this.stats = {
      priceChecks: 0,
      dropsDetected: 0,
      lastCheckTime: 0,
    };
  }

  /**
   * Initialize price monitor
   */
  async initialize() {
    if (this.chain.aaveV3?.oracle) {
      this.oracle = new ethers.Contract(
        this.chain.aaveV3.oracle,
        AAVE_ORACLE_ABI,
        this.provider
      );
      console.log(`   📈 Price Monitor initialized`);
      return true;
    }
    console.log(`   ⚠️ No oracle available for price monitoring`);
    return false;
  }

  /**
   * Set callback for price drops
   */
  setPriceDropCallback(callback) {
    this.onPriceDrop = callback;
  }

  /**
   * Start monitoring prices
   */
  start(tokensToWatch) {
    this.tokensToWatch = tokensToWatch || this.getDefaultTokens();

    // Initial fetch
    this.checkPrices();

    // Periodic checks
    this.interval = setInterval(
      () => this.checkPrices(),
      this.settings.checkIntervalMs
    );

    console.log(`   👁️ Watching ${this.tokensToWatch.length} token prices`);
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  /**
   * Get default tokens to watch (major assets that affect liquidations)
   */
  getDefaultTokens() {
    const tokens = [];

    // Add wrapped native
    if (this.chain.wrappedNative) {
      tokens.push({ address: this.chain.wrappedNative, symbol: `W${this.chain.nativeToken}` });
    }

    // Add stablecoins and major tokens
    const allTokens = { ...this.chain.tokens };
    for (const [symbol, address] of Object.entries(allTokens)) {
      if (address && !tokens.find(t => t.address.toLowerCase() === address.toLowerCase())) {
        tokens.push({ address, symbol });
      }
    }

    return tokens.slice(0, 10); // Limit to top 10
  }

  /**
   * Check all token prices
   */
  async checkPrices() {
    if (!this.oracle || !this.tokensToWatch?.length) return;

    this.stats.priceChecks++;
    this.stats.lastCheckTime = Date.now();

    try {
      // Batch get prices
      const addresses = this.tokensToWatch.map(t => t.address);
      const prices = await this.oracle.getAssetsPrices(addresses);

      const now = Date.now();

      for (let i = 0; i < this.tokensToWatch.length; i++) {
        const token = this.tokensToWatch[i];
        const priceRaw = prices[i];
        const price = parseFloat(ethers.formatUnits(priceRaw, 8)); // 8 decimals

        // Store current price
        const oldPrice = this.currentPrices.get(token.address);
        this.currentPrices.set(token.address, { price, timestamp: now });

        // Add to history
        let history = this.priceHistory.get(token.address) || [];
        history.push({ price, timestamp: now });
        if (history.length > this.historyLength) {
          history = history.slice(-this.historyLength);
        }
        this.priceHistory.set(token.address, history);

        // Check for significant drop
        if (oldPrice && oldPrice.price > 0) {
          const dropPercent = ((oldPrice.price - price) / oldPrice.price) * 100;

          if (dropPercent >= this.settings.alertDropPercent) {
            this.stats.dropsDetected++;
            console.log(`\n   📉 PRICE DROP: ${token.symbol} -${dropPercent.toFixed(2)}%`);
            console.log(`      $${oldPrice.price.toFixed(4)} → $${price.toFixed(4)}`);

            if (this.onPriceDrop) {
              this.onPriceDrop({
                token: token.address,
                symbol: token.symbol,
                oldPrice: oldPrice.price,
                newPrice: price,
                dropPercent,
              });
            }
          }
        }
      }
    } catch (error) {
      // Silently fail - will retry next interval
    }
  }

  /**
   * Get current price for a token
   */
  getPrice(tokenAddress) {
    return this.currentPrices.get(tokenAddress.toLowerCase())?.price || null;
  }

  /**
   * Get price change over last N minutes
   */
  getPriceChange(tokenAddress, minutes = 5) {
    const history = this.priceHistory.get(tokenAddress.toLowerCase());
    if (!history || history.length < 2) return null;

    const now = Date.now();
    const cutoff = now - (minutes * 60 * 1000);

    // Find oldest price in range
    const oldEntry = history.find(h => h.timestamp >= cutoff) || history[0];
    const newEntry = history[history.length - 1];

    if (oldEntry.price === 0) return null;

    return {
      oldPrice: oldEntry.price,
      newPrice: newEntry.price,
      changePercent: ((newEntry.price - oldEntry.price) / oldEntry.price) * 100,
    };
  }

  /**
   * Get native token price in USD
   */
  async getNativePrice() {
    if (!this.chain.wrappedNative) return null;

    const cached = this.currentPrices.get(this.chain.wrappedNative);
    if (cached && Date.now() - cached.timestamp < 60000) {
      return cached.price;
    }

    try {
      const price = await this.oracle.getAssetPrice(this.chain.wrappedNative);
      const priceUSD = parseFloat(ethers.formatUnits(price, 8));
      this.currentPrices.set(this.chain.wrappedNative, { price: priceUSD, timestamp: Date.now() });
      return priceUSD;
    } catch {
      return null;
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return this.stats;
  }
}

module.exports = PriceMonitor;

