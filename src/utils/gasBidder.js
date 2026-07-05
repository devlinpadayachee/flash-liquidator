/**
 * Smart Gas Bidder
 *
 * Dynamically adjusts gas price based on:
 * - Expected profit
 * - Competition level
 * - Network congestion
 */

const { ethers } = require('ethers');

class GasBidder {
  constructor(chainConfig, provider) {
    this.chain = chainConfig;
    this.provider = provider;

    // Settings
    this.settings = {
      // Maximum percentage of profit to spend on gas
      maxGasProfitPercent: parseFloat(process.env.MAX_GAS_PROFIT_PERCENT || '30'),

      // Minimum priority fee boost (gwei)
      minPriorityBoost: parseFloat(process.env.MIN_PRIORITY_BOOST || '1'),

      // Maximum priority fee (gwei)
      maxPriorityFee: parseFloat(process.env.MAX_PRIORITY_FEE || '50'),

      // For time-sensitive liquidations, boost priority
      urgentMultiplier: parseFloat(process.env.URGENT_GAS_MULTIPLIER || '1.5'),
    };

    // Recent gas prices for averaging
    this.gasHistory = [];
    this.maxHistoryLength = 10;

    // Stats
    this.stats = {
      bidsMade: 0,
      avgPriorityFee: 0,
      maxPriorityFeePaid: 0,
    };
  }

  /**
   * Calculate optimal gas settings for a liquidation
   *
   * @param expectedProfitUSD Expected profit in USD
   * @param isUrgent Whether this is time-sensitive
   * @returns Gas settings for transaction
   */
  async calculateGasSettings(expectedProfitUSD, isUrgent = false) {
    // Get current network gas prices
    const feeData = await this.provider.getFeeData();
    const baseFee = feeData.gasPrice || ethers.parseUnits('30', 'gwei');
    const suggestedPriority = feeData.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei');

    // Get native token price for USD conversion
    const nativePrice = await this.getNativePrice();

    // Calculate max we're willing to pay in gas
    const maxGasUSD = expectedProfitUSD * (this.settings.maxGasProfitPercent / 100);

    // Estimate gas units for liquidation
    const estimatedGasUnits = 500000n; // Conservative estimate

    // Calculate max gas price we can afford
    const maxGasPriceWei = BigInt(Math.floor(
      (maxGasUSD / nativePrice) * 1e18 / Number(estimatedGasUnits)
    ));

    // Calculate priority fee
    let priorityFee = suggestedPriority;

    // Add boost for competitive edge
    const boostWei = ethers.parseUnits(String(this.settings.minPriorityBoost), 'gwei');
    priorityFee = priorityFee + boostWei;

    // Apply urgent multiplier if needed
    if (isUrgent) {
      priorityFee = priorityFee * BigInt(Math.floor(this.settings.urgentMultiplier * 100)) / 100n;
    }

    // Cap at maximum
    const maxPriorityWei = ethers.parseUnits(String(this.settings.maxPriorityFee), 'gwei');
    if (priorityFee > maxPriorityWei) {
      priorityFee = maxPriorityWei;
    }

    // maxFeePerGas must never drop below baseFee + priorityFee or the tx
    // gets stuck/rejected. Cap by affordability only when the cap still
    // clears that floor; use 2x base fee headroom for base-fee spikes.
    const networkFloor = baseFee + priorityFee;
    let maxFee = (baseFee * 2n) + priorityFee;
    if (maxGasPriceWei > networkFloor && maxFee > maxGasPriceWei) {
      maxFee = maxGasPriceWei;
    }

    // Record for stats
    this.recordBid(priorityFee);

    return {
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
      gasLimit: estimatedGasUnits,
      estimatedCostUSD: this.calculateCostUSD(networkFloor, estimatedGasUnits, nativePrice),
      type: 2, // EIP-1559
    };
  }

  /**
   * Calculate gas cost in USD
   */
  calculateCostUSD(gasPrice, gasUnits, nativePrice) {
    const costWei = gasPrice * gasUnits;
    const costNative = parseFloat(ethers.formatEther(costWei));
    return costNative * nativePrice;
  }

  /**
   * Get native token price
   */
  async getNativePrice() {
    // Default prices by chain
    const defaults = {
      POLYGON: 0.20,
      ARBITRUM: 3500,
      BASE: 3500,
      BSC: 600,
      AVALANCHE: 35,
    };

    // TODO: Get real price from oracle
    return defaults[this.chain.name?.toUpperCase()] || 1;
  }

  /**
   * Record a bid for stats
   */
  recordBid(priorityFee) {
    const feeGwei = parseFloat(ethers.formatUnits(priorityFee, 'gwei'));

    this.gasHistory.push(feeGwei);
    if (this.gasHistory.length > this.maxHistoryLength) {
      this.gasHistory.shift();
    }

    this.stats.bidsMade++;
    this.stats.avgPriorityFee = this.gasHistory.reduce((a, b) => a + b, 0) / this.gasHistory.length;
    this.stats.maxPriorityFeePaid = Math.max(this.stats.maxPriorityFeePaid, feeGwei);
  }

  /**
   * Check if gas is too high right now
   */
  async isGasTooHigh(maxGasUSD) {
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits('30', 'gwei');
    const estimatedGasUnits = 500000n;
    const nativePrice = await this.getNativePrice();

    const costUSD = this.calculateCostUSD(gasPrice, estimatedGasUnits, nativePrice);
    return costUSD > maxGasUSD;
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      ...this.stats,
      avgPriorityFee: this.stats.avgPriorityFee.toFixed(2) + ' gwei',
      maxPriorityFeePaid: this.stats.maxPriorityFeePaid.toFixed(2) + ' gwei',
    };
  }
}

module.exports = GasBidder;

