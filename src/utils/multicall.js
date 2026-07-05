/**
 * Multicall Utility
 *
 * Batches multiple RPC calls into one for:
 * - Reduced RPC usage (save credits!)
 * - Faster response times
 * - Atomic data consistency
 */

const { ethers } = require('ethers');

// Multicall3 is deployed at the same address on all major chains
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external view returns (tuple(bool success, bytes returnData)[])',
  'function getBlockNumber() external view returns (uint256)',
];

class Multicall {
  constructor(provider, chainName) {
    this.provider = provider;
    this.chainName = chainName;
    this.contract = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
  }

  /**
   * Execute multiple calls in a single RPC request
   *
   * @param calls Array of { target, interface, method, args }
   * @returns Array of decoded results
   */
  async aggregate(calls) {
    if (calls.length === 0) return [];

    // Build multicall input
    const multicallCalls = calls.map(call => ({
      target: call.target,
      allowFailure: true,
      callData: call.interface.encodeFunctionData(call.method, call.args || []),
    }));

    try {
      // Execute multicall
      const results = await this.contract.aggregate3(multicallCalls);

      // Decode results
      return results.map((result, i) => {
        if (!result.success) {
          return { success: false, data: null, error: 'Call failed' };
        }

        try {
          const decoded = calls[i].interface.decodeFunctionResult(
            calls[i].method,
            result.returnData
          );
          return { success: true, data: decoded, error: null };
        } catch (error) {
          return { success: false, data: null, error: error.message };
        }
      });
    } catch (error) {
      // Multicall failed entirely - try smaller batches
      if (calls.length > 10) {
        console.log(`   ⚠️ Multicall failed (${calls.length} calls), retrying in smaller batches...`);
        return await this.aggregateWithFallback(calls);
      }

      // Small batch failed - return all as errors
      return calls.map(() => ({
        success: false,
        data: null,
        error: error.message || 'Multicall failed',
      }));
    }
  }

  /**
   * Fallback: Split into smaller batches when multicall fails
   */
  async aggregateWithFallback(calls) {
    const results = [];
    const batchSize = Math.max(10, Math.floor(calls.length / 5)); // Split into ~5 smaller batches

    for (let i = 0; i < calls.length; i += batchSize) {
      const batch = calls.slice(i, i + batchSize);

      const multicallCalls = batch.map(call => ({
        target: call.target,
        allowFailure: true,
        callData: call.interface.encodeFunctionData(call.method, call.args || []),
      }));

      try {
        const batchResults = await this.contract.aggregate3(multicallCalls);

        for (let j = 0; j < batchResults.length; j++) {
          const result = batchResults[j];
          if (!result.success) {
            results.push({ success: false, data: null, error: 'Call failed' });
          } else {
            try {
              const decoded = batch[j].interface.decodeFunctionResult(
                batch[j].method,
                result.returnData
              );
              results.push({ success: true, data: decoded, error: null });
            } catch (decodeError) {
              results.push({ success: false, data: null, error: decodeError.message });
            }
          }
        }
      } catch (batchError) {
        // This smaller batch also failed - mark all as errors
        for (let j = 0; j < batch.length; j++) {
          results.push({ success: false, data: null, error: batchError.message || 'Batch failed' });
        }
      }

      // Small delay between batches
      if (i + batchSize < calls.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    return results;
  }

  /**
   * Batch get health factors for multiple Aave users
   */
  async batchGetAaveHealthFactors(poolAddress, userAddresses, poolAbi) {
    const poolInterface = new ethers.Interface(poolAbi);

    const calls = userAddresses.map(user => ({
      target: poolAddress,
      interface: poolInterface,
      method: 'getUserAccountData',
      args: [user],
    }));

    const results = await this.aggregate(calls);

    return results.map((result, i) => {
      if (!result.success) {
        return { user: userAddresses[i], error: result.error };
      }

      const data = result.data;
      return {
        user: userAddresses[i],
        totalCollateralBase: data.totalCollateralBase,
        totalDebtBase: data.totalDebtBase,
        availableBorrowsBase: data.availableBorrowsBase,
        currentLiquidationThreshold: data.currentLiquidationThreshold,
        ltv: data.ltv,
        healthFactor: data.healthFactor,
      };
    });
  }

  /**
   * Batch get token prices from Aave oracle
   */
  async batchGetPrices(oracleAddress, tokenAddresses, oracleAbi) {
    const oracleInterface = new ethers.Interface(oracleAbi);

    const calls = tokenAddresses.map(token => ({
      target: oracleAddress,
      interface: oracleInterface,
      method: 'getAssetPrice',
      args: [token],
    }));

    const results = await this.aggregate(calls);

    return results.map((result, i) => {
      if (!result.success) {
        return { token: tokenAddresses[i], price: null, error: result.error };
      }
      return {
        token: tokenAddresses[i],
        price: result.data[0], // Price in base currency (8 decimals for USD)
        error: null,
      };
    });
  }

  /**
   * Batch get swap quotes from multiple DEXes
   */
  async batchGetSwapQuotes(routerAddresses, amountIn, path, routerAbi) {
    const routerInterface = new ethers.Interface(routerAbi);

    const calls = routerAddresses.map(router => ({
      target: router.address,
      interface: routerInterface,
      method: 'getAmountsOut',
      args: [amountIn, path],
    }));

    const results = await this.aggregate(calls);

    return results.map((result, i) => {
      if (!result.success) {
        return { router: routerAddresses[i], amountOut: null, error: result.error };
      }

      const amounts = result.data[0];
      return {
        router: routerAddresses[i],
        amountOut: amounts[amounts.length - 1],
        error: null,
      };
    });
  }

  /**
   * Get current block number (useful for syncing)
   */
  async getBlockNumber() {
    return await this.contract.getBlockNumber();
  }
}

module.exports = Multicall;

