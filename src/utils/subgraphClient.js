/**
 * Subgraph Client
 *
 * Unified client for querying borrower data from multiple lending protocol subgraphs.
 * Handles rate limiting, retries, and data normalization.
 */

const {
  getSubgraphsForChain,
  getQueryTemplate,
  PROTOCOL_CONFIG,
} = require('../config/subgraphs');

class SubgraphClient {
  constructor(chainName) {
    this.chainName = chainName?.toUpperCase();
    this.endpoints = getSubgraphsForChain(this.chainName);

    // Rate limiting
    this.requestDelay = 200; // ms between requests
    this.lastRequest = 0;

    // Cache
    this.cache = new Map();
    this.cacheTimeout = 60000; // 1 minute

    // Stats
    this.stats = {
      requests: 0,
      errors: 0,
      borrowersFetched: 0,
    };
  }

  /**
   * Initialize and test endpoints
   */
  async initialize() {
    console.log(`\n📡 Initializing Subgraph Client for ${this.chainName}...`);

    const protocols = Object.keys(this.endpoints);

    if (protocols.length === 0) {
      console.log(`   ⚠️ No subgraph endpoints available for ${this.chainName}`);
      console.log(`   💡 To enable subgraphs, add to your .env:`);
      console.log(`      GRAPH_API_KEY=your_free_key_from_thegraph.com/studio`);
      console.log(`   📡 Falling back to RPC-only mode`);
      this.available = false;
      return false;
    }

    console.log(`   Found ${protocols.length} protocols: ${protocols.join(', ')}`);

    // Test each endpoint
    let workingCount = 0;
    for (const protocol of protocols) {
      const endpoint = this.endpoints[protocol];
      const url = endpoint.native;

      if (!url) continue;

      try {
        // Simple health check query
        const result = await this.query(url, '{ _meta { block { number } } }');
        const blockNum = result?._meta?.block?.number;
        console.log(`   ✅ ${protocol}: Block ${blockNum || 'connected'}`);
        workingCount++;
      } catch (err) {
        const msg = err.message?.slice(0, 50) || 'connection failed';
        console.log(`   ❌ ${protocol}: ${msg}`);
      }
    }

    this.available = workingCount > 0;

    if (!this.available) {
      console.log(`\n   ⚠️ No working subgraph endpoints!`);
      console.log(`   💡 Get a FREE API key from: https://thegraph.com/studio/`);
      console.log(`      Then add GRAPH_API_KEY=your_key to .env`);
    }

    return this.available;
  }

  /**
   * Execute a GraphQL query
   */
  async query(url, query, variables = {}) {
    // Rate limiting
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.requestDelay) {
      await new Promise(r => setTimeout(r, this.requestDelay - elapsed));
    }
    this.lastRequest = Date.now();

    this.stats.requests++;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.errors) {
        throw new Error(data.errors[0]?.message || 'GraphQL error');
      }

      return data.data;
    } catch (error) {
      this.stats.errors++;
      throw error;
    }
  }

  /**
   * Fetch borrowers from all protocols on this chain
   * Now supports pagination for 5000+ borrowers
   */
  async fetchAllBorrowers(options = {}) {
    const {
      minDebtUSD = 50,
      maxDebtUSD = 10000,
      limit = 1000,
      skip = 0,
    } = options;

    const allBorrowers = [];

    for (const [protocolName, endpoint] of Object.entries(this.endpoints)) {
      try {
        const borrowers = await this.fetchProtocolBorrowers(
          protocolName,
          endpoint,
          { minDebtUSD, maxDebtUSD, limit, skip }
        );

        allBorrowers.push(...borrowers);

        if (borrowers.length > 0) {
          console.log(`   📊 ${protocolName}: ${borrowers.length} borrowers (skip=${skip})`);
        }

      } catch (err) {
        console.log(`   ⚠️ ${protocolName}: ${err.message?.slice(0, 50)}`);
      }
    }

    this.stats.borrowersFetched += allBorrowers.length;
    return allBorrowers;
  }

  /**
   * Fetch borrowers from a specific protocol
   */
  async fetchProtocolBorrowers(protocolName, endpoint, options) {
    const config = endpoint.config || PROTOCOL_CONFIG.AAVE_V3;
    const url = endpoint.native || endpoint.messari;

    if (!url) return [];

    // Try native query first, then Messari fallback
    let borrowers = [];

    try {
      borrowers = await this.fetchWithNativeQuery(protocolName, url, config, options);
    } catch (err) {
      // Try Messari if native fails
      if (endpoint.messari && endpoint.messari !== url) {
        try {
          borrowers = await this.fetchWithMessariQuery(protocolName, endpoint.messari, options);
        } catch (err2) {
          // Both failed
        }
      }
    }

    return borrowers;
  }

  /**
   * Fetch using native protocol query (with pagination support)
   */
  async fetchWithNativeQuery(protocolName, url, config, options) {
    const queryTemplate = getQueryTemplate(config.type, 'BORROWERS');

    if (!queryTemplate) {
      throw new Error('No query template');
    }

    const variables = {
      first: Math.min(options.limit || 1000, 1000),
      skip: options.skip || 0,
      minDebt: String(options.minDebtUSD || 0),
    };

    const result = await this.query(url, queryTemplate, variables);

    // Normalize based on protocol type
    return this.normalizeBorrowers(result, config.type, protocolName);
  }

  /**
   * Fetch using Messari standardized query
   */
  async fetchWithMessariQuery(protocolName, url, options) {
    const query = getQueryTemplate('MESSARI', 'BORROWERS');

    const variables = {
      first: Math.min(options.limit || 500, 1000),
      skip: 0,
      minDebt: String(options.minDebtUSD || 0),
    };

    const result = await this.query(url, query, variables);

    // Messari format
    const positions = result?.positions || [];

    return positions.map(pos => ({
      address: pos.account?.id?.toLowerCase(),
      protocol: protocolName,
      protocolType: 'MESSARI',
      debtAmount: parseFloat(pos.balance || 0),
      market: pos.market?.name,
      token: pos.market?.inputToken?.symbol,
      raw: pos,
    }));
  }

  /**
   * Normalize borrower data from different protocol formats
   */
  normalizeBorrowers(result, protocolType, protocolName) {
    switch (protocolType) {
      case 'AAVE_V3':
      case 'RADIANT':
      case 'SEAMLESS':
        return this.normalizeAaveBorrowers(result, protocolName);

      case 'VENUS':
        return this.normalizeVenusBorrowers(result, protocolName);

      case 'BENQI':
      case 'MOONWELL':
        return this.normalizeCompoundForkBorrowers(result, protocolName);

      default:
        return [];
    }
  }

  /**
   * Normalize Aave V3 format
   */
  normalizeAaveBorrowers(result, protocolName) {
    const users = result?.users || [];

    return users.map(user => {
      // Calculate total debt from reserves
      let totalDebtUSD = 0;
      const debts = [];

      for (const reserve of (user.reserves || [])) {
        const debt = parseFloat(reserve.currentTotalDebt || 0);
        const decimals = parseInt(reserve.reserve?.decimals || 18);
        const debtNormalized = debt / Math.pow(10, decimals);

        // Rough USD estimate (price data may not be in this query)
        debts.push({
          token: reserve.reserve?.symbol,
          amount: debtNormalized,
          address: reserve.reserve?.underlyingAsset,
        });

        totalDebtUSD += debtNormalized; // Will be updated with real price later
      }

      return {
        address: user.id?.toLowerCase(),
        protocol: protocolName,
        protocolType: 'AAVE_V3',
        borrowedReservesCount: user.borrowedReservesCount || 0,
        debts,
        totalDebtUSD,
        healthFactor: null, // Calculated on-chain
        raw: user,
      };
    });
  }

  /**
   * Normalize Venus format
   */
  normalizeVenusBorrowers(result, protocolName) {
    const accounts = result?.accounts || [];

    return accounts.map(account => ({
      address: account.id?.toLowerCase(),
      protocol: protocolName,
      protocolType: 'VENUS',
      totalDebtUSD: parseFloat(account.totalBorrowValueInUSD || 0),
      totalCollateralUSD: parseFloat(account.totalCollateralValueInUSD || 0),
      healthFactor: parseFloat(account.health || 0),
      tokens: account.tokens?.map(t => ({
        symbol: t.market?.underlyingSymbol,
        borrowBalance: parseFloat(t.storedBorrowBalance || 0),
        priceUSD: parseFloat(t.market?.underlyingPriceUSD || 0),
      })) || [],
      raw: account,
    }));
  }

  /**
   * Normalize Compound-fork format (Moonwell, Benqi)
   */
  normalizeCompoundForkBorrowers(result, protocolName) {
    const accounts = result?.accounts || [];

    return accounts.map(account => ({
      address: account.id?.toLowerCase(),
      protocol: protocolName,
      protocolType: 'COMPOUND_FORK',
      totalDebtUSD: parseFloat(account.totalBorrowValueInUSD || 0),
      healthFactor: parseFloat(account.health || 0),
      tokens: account.tokens?.map(t => ({
        symbol: t.market?.underlyingSymbol,
        borrowBalance: parseFloat(t.storedBorrowBalance || 0),
        priceUSD: parseFloat(t.market?.underlyingPriceUSD || 0),
        collateralFactor: parseFloat(t.market?.collateralFactor || 0),
      })) || [],
      raw: account,
    }));
  }

  /**
   * Fetch at-risk borrowers (health factor close to 1)
   * This requires on-chain data for accurate health factors
   */
  async fetchAtRiskBorrowers(options = {}) {
    const allBorrowers = await this.fetchAllBorrowers(options);

    // Filter by debt range
    const { minDebtUSD = 50, maxDebtUSD = 10000 } = options;

    return allBorrowers.filter(b => {
      const debt = b.totalDebtUSD || 0;
      return debt >= minDebtUSD && debt <= maxDebtUSD;
    });
  }

  /**
   * Get protocols available on this chain
   */
  getAvailableProtocols() {
    return Object.keys(this.endpoints);
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      ...this.stats,
      chain: this.chainName,
      protocols: Object.keys(this.endpoints).length,
    };
  }
}

module.exports = SubgraphClient;

