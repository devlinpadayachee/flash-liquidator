/**
 * MEV Protection Module
 *
 * Submits transactions to private mempools to prevent frontrunning.
 * Critical for liquidations - other bots WILL try to frontrun you!
 */

const { ethers } = require('ethers');

// Private RPC endpoints by chain
// NOTE: Only list endpoints that actually accept transactions for that chain.
// Previously this table pointed Polygon/Arbitrum/Base/Avalanche at relays that
// are either dead (Marlin Polygon: DNS no longer resolves) or Ethereum-mainnet
// only (MEV Blocker, Flashbots Protect). Sending there burned seconds of
// latency per liquidation before falling back to the public mempool - a
// guaranteed lost race. An empty list disables the module for that chain and
// sends directly via your own RPC, which is the fastest available path.
const PRIVATE_ENDPOINTS = {
  POLYGON: [],
  ARBITRUM: [], // Arbitrum has a FCFS sequencer - no public mempool to hide from
  BASE: [],
  BSC: [
    {
      name: '48 Club',
      url: 'https://rpc.48.club',
      method: 'eth_sendRawTransaction',
    },
    {
      name: 'bloXroute',
      url: 'https://bsc.rpc.blxrbdn.com',
      method: 'eth_sendRawTransaction',
    },
  ],
  AVALANCHE: [],
};

class MEVProtection {
  constructor(chainName) {
    this.chainName = chainName.toUpperCase();
    this.endpoints = PRIVATE_ENDPOINTS[this.chainName] || [];
    this.enabled = process.env.USE_MEV_PROTECTION === 'true';
    this.wallet = null;
    this.provider = null;

    // Stats
    this.stats = {
      privateTxSent: 0,
      privateTxSuccess: 0,
      privateTxFailed: 0,
      publicFallbacks: 0,
    };
  }

  /**
   * Initialize with wallet
   */
  initialize(wallet, provider) {
    this.wallet = wallet;
    this.provider = provider;

    if (this.enabled && this.endpoints.length > 0) {
      console.log(`   🔒 MEV Protection: ENABLED (${this.endpoints.length} private endpoints)`);
      for (const ep of this.endpoints) {
        console.log(`      - ${ep.name}`);
      }
    } else if (this.enabled) {
      console.log(`   ⚠️ MEV Protection: No private endpoints for ${this.chainName}`);
      this.enabled = false;
    } else {
      console.log(`   ⚠️ MEV Protection: DISABLED (add USE_MEV_PROTECTION=true to enable)`);
    }
  }

  /**
   * Send transaction with MEV protection
   */
  async sendProtectedTransaction(signedTx) {
    if (!this.enabled || this.endpoints.length === 0) {
      // Fall back to public mempool
      this.stats.publicFallbacks++;
      return await this.provider.broadcastTransaction(signedTx);
    }

    this.stats.privateTxSent++;

    // Try each private endpoint
    for (const endpoint of this.endpoints) {
      try {
        const result = await this.sendToPrivateEndpoint(endpoint, signedTx);
        if (result.success) {
          this.stats.privateTxSuccess++;
          console.log(`   🔒 Sent via ${endpoint.name}`);
          return result.response;
        }
      } catch (error) {
        console.log(`   ⚠️ ${endpoint.name} failed: ${error.message?.slice(0, 50)}`);
      }
    }

    // All private endpoints failed - fall back to public
    console.log(`   ⚠️ All private endpoints failed, using public mempool`);
    this.stats.privateTxFailed++;
    this.stats.publicFallbacks++;
    return await this.provider.broadcastTransaction(signedTx);
  }

  /**
   * Send to a specific private endpoint
   */
  async sendToPrivateEndpoint(endpoint, signedTx) {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: endpoint.method,
        params: [signedTx],
      }),
      // A slow relay must not cost us the race - fail fast, next endpoint
      signal: AbortSignal.timeout(3000),
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || 'Private endpoint error');
    }

    return {
      success: true,
      response: {
        hash: data.result,
        wait: async () => {
          // Wait for transaction to be mined
          return await this.provider.waitForTransaction(data.result);
        },
      },
    };
  }

  /**
   * Create and send a protected transaction
   */
  async sendProtectedContractCall(contract, method, args, overrides = {}) {
    // Prepare transaction
    const tx = await contract[method].populateTransaction(...args, overrides);

    // Get nonce and gas
    const nonce = await this.wallet.getNonce();
    const feeData = await this.provider.getFeeData();

    // Build full transaction
    const fullTx = {
      ...tx,
      nonce,
      chainId: (await this.provider.getNetwork()).chainId,
      gasLimit: overrides.gasLimit || 500000n,
      // Respect caller's gas bid (GasBidder output) - only fall back to
      // network defaults when no bid was provided
      maxFeePerGas: overrides.maxFeePerGas || feeData.maxFeePerGas,
      maxPriorityFeePerGas: overrides.maxPriorityFeePerGas || feeData.maxPriorityFeePerGas,
      type: 2, // EIP-1559
    };

    // Sign transaction
    const signedTx = await this.wallet.signTransaction(fullTx);

    // Send with MEV protection
    return await this.sendProtectedTransaction(signedTx);
  }

  /**
   * Get stats
   */
  getStats() {
    return this.stats;
  }
}

module.exports = MEVProtection;

