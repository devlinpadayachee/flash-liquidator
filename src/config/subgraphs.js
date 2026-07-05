/**
 * Subgraph Configuration
 *
 * Endpoints for querying borrower data from lending protocols.
 * Uses Messari standardized subgraphs where available for consistent schemas.
 */

// ============================================================
// ACTIVE SUBGRAPH ENDPOINTS (Updated December 2024)
// ============================================================
// The Graph hosted service was deprecated in June 2024.
// Options:
// 1. Decentralized network (requires free API key from thegraph.com/studio)
// 2. Alternative indexers (Alchemy Subgraphs, Satsuma, etc.)
// 3. Direct RPC (fallback - slower but always works)

// Decentralized network subgraphs (requires GRAPH_API_KEY env var)
// Get FREE API key from: https://thegraph.com/studio/
const DECENTRALIZED_SUBGRAPHS = {
  POLYGON: {
    AAVE_V3: 'https://gateway.thegraph.com/api/{api-key}/subgraphs/id/Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211',
  },
  ARBITRUM: {
    AAVE_V3: 'https://gateway.thegraph.com/api/{api-key}/subgraphs/id/DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B',
    RADIANT: 'https://gateway.thegraph.com/api/{api-key}/subgraphs/id/8UEKLjYzZVNYD1td3HRmzY71zfnFh6Jz89K6xNkWRmMo',
  },
  BASE: {
    AAVE_V3: 'https://gateway.thegraph.com/api/{api-key}/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF',
  },
  AVALANCHE: {
    AAVE_V3: 'https://gateway.thegraph.com/api/{api-key}/subgraphs/id/4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf',
  },
};

// Alternative: Alchemy Subgraphs (requires Alchemy API key)
const ALCHEMY_SUBGRAPHS = {
  POLYGON: {
    AAVE_V3: 'https://subgraph.satsuma-prod.com/{api-key}/aave/protocol-v3-polygon/api',
  },
  ARBITRUM: {
    AAVE_V3: 'https://subgraph.satsuma-prod.com/{api-key}/aave/protocol-v3-arbitrum/api',
  },
};

// Native protocol subgraphs (some still work without API key)
const NATIVE_SUBGRAPHS = {
  BSC: {
    // Venus maintains their own API
    VENUS: 'https://api.venus.io/api/governance/venus',
  },
};

// Legacy - all deprecated
const MESSARI_SUBGRAPHS = {};

/**
 * Query templates for different subgraph types
 */
const QUERY_TEMPLATES = {
  // Messari standardized schema
  MESSARI: {
    // Get all positions with active borrows
    BORROWERS: `
      query GetBorrowers($first: Int!, $skip: Int!, $minDebt: BigDecimal!) {
        positions(
          first: $first
          skip: $skip
          where: {
            side: BORROWER
            balance_gt: $minDebt
            account_: { openPositionCount_gt: 0 }
          }
          orderBy: balance
          orderDirection: desc
        ) {
          id
          account { id }
          market {
            id
            name
            inputToken { symbol decimals }
          }
          balance
          side
        }
      }
    `,

    // Get at-risk positions (requires healthFactor field which may not exist)
    AT_RISK_POSITIONS: `
      query GetAtRiskPositions($first: Int!, $skip: Int!) {
        accounts(
          first: $first
          skip: $skip
          where: { openPositionCount_gt: 0 }
        ) {
          id
          openPositionCount
          positions(where: { side: BORROWER, balance_gt: 0 }) {
            id
            market {
              id
              name
              inputToken { symbol decimals }
              liquidationThreshold
            }
            balance
          }
        }
      }
    `,
  },

  // Aave V3 native schema
  AAVE_V3: {
    // Get users with active borrows
    BORROWERS: `
      query GetBorrowers($first: Int!, $skip: Int!) {
        users(
          first: $first
          skip: $skip
          where: { borrowedReservesCount_gt: 0 }
          orderBy: id
        ) {
          id
          borrowedReservesCount
          reserves(where: { currentTotalDebt_gt: 0 }) {
            currentTotalDebt
            reserve {
              symbol
              decimals
              underlyingAsset
              liquidityRate
              variableBorrowRate
            }
          }
        }
      }
    `,

    // Get user reserve data for health calculation
    USER_RESERVES: `
      query GetUserReserves($userId: String!) {
        user(id: $userId) {
          id
          reserves {
            currentATokenBalance
            currentTotalDebt
            usageAsCollateralEnabledOnUser
            reserve {
              symbol
              decimals
              underlyingAsset
              price { priceInEth }
              reserveLiquidationThreshold
            }
          }
        }
      }
    `,
  },

  // Venus native schema
  VENUS: {
    BORROWERS: `
      query GetBorrowers($first: Int!, $skip: Int!) {
        accounts(
          first: $first
          skip: $skip
          where: { hasBorrowed: true }
          orderBy: totalBorrowValueInUSD
          orderDirection: desc
        ) {
          id
          hasBorrowed
          totalBorrowValueInUSD
          totalCollateralValueInUSD
          health
          tokens {
            symbol
            storedBorrowBalance
            market {
              underlyingSymbol
              underlyingPriceUSD
            }
          }
        }
      }
    `,
  },

  // Radiant native schema (similar to Aave)
  RADIANT: {
    BORROWERS: `
      query GetBorrowers($first: Int!, $skip: Int!) {
        users(
          first: $first
          skip: $skip
          where: { borrowedReservesCount_gt: 0 }
        ) {
          id
          borrowedReservesCount
          reserves(where: { currentTotalDebt_gt: 0 }) {
            currentTotalDebt
            reserve {
              symbol
              decimals
              underlyingAsset
            }
          }
        }
      }
    `,
  },

  // Moonwell/Compound-fork schema
  COMPOUND_FORK: {
    BORROWERS: `
      query GetBorrowers($first: Int!, $skip: Int!) {
        accounts(
          first: $first
          skip: $skip
          where: { hasBorrowed: true }
        ) {
          id
          hasBorrowed
          totalBorrowValueInUSD
          health
          tokens {
            cTokenBalance
            storedBorrowBalance
            market {
              symbol
              underlyingSymbol
              underlyingPriceUSD
              collateralFactor
            }
          }
        }
      }
    `,
  },
};

/**
 * Protocol configurations
 */
const PROTOCOL_CONFIG = {
  AAVE_V3: {
    type: 'AAVE_V3',
    queryTemplate: 'AAVE_V3',
    liquidationBonus: 500, // 5% default
    closeFactor: 5000, // 50%
  },
  COMPOUND_V3: {
    type: 'COMPOUND_V3',
    queryTemplate: 'MESSARI',
    liquidationBonus: 500,
    closeFactor: 5000,
  },
  RADIANT: {
    type: 'RADIANT',
    queryTemplate: 'RADIANT',
    liquidationBonus: 1500, // 15%! Best in DeFi
    closeFactor: 5000,
  },
  VENUS: {
    type: 'VENUS',
    queryTemplate: 'VENUS',
    liquidationBonus: 1000, // 10%
    closeFactor: 5000,
  },
  BENQI: {
    type: 'BENQI',
    queryTemplate: 'COMPOUND_FORK',
    liquidationBonus: 800, // 8%
    closeFactor: 5000,
  },
  MOONWELL: {
    type: 'MOONWELL',
    queryTemplate: 'COMPOUND_FORK',
    liquidationBonus: 800, // 8%
    closeFactor: 5000,
  },
  SEAMLESS: {
    type: 'SEAMLESS',
    queryTemplate: 'AAVE_V3', // Aave fork
    liquidationBonus: 500,
    closeFactor: 5000,
  },
};

/**
 * Get subgraph endpoints for a chain
 */
function getSubgraphsForChain(chainName) {
  const chain = chainName?.toUpperCase();
  const native = NATIVE_SUBGRAPHS[chain] || {};
  const decentralized = DECENTRALIZED_SUBGRAPHS[chain] || {};
  const alchemy = ALCHEMY_SUBGRAPHS[chain] || {};

  // Build endpoints map
  const endpoints = {};
  const graphApiKey = process.env.GRAPH_API_KEY;
  const alchemyApiKey = process.env.ALCHEMY_API_KEY;

  // Gather all protocols across all sources
  const allProtocols = new Set([
    ...Object.keys(native),
    ...Object.keys(decentralized),
    ...Object.keys(alchemy),
  ]);

  for (const protocol of allProtocols) {
    let primaryUrl = null;

    // Priority: 1. Decentralized (The Graph) with API key
    if (graphApiKey && decentralized[protocol]) {
      primaryUrl = decentralized[protocol].replace('{api-key}', graphApiKey);
    }
    // Priority: 2. Alchemy with API key
    else if (alchemyApiKey && alchemy[protocol]) {
      primaryUrl = alchemy[protocol].replace('{api-key}', alchemyApiKey);
    }
    // Priority: 3. Native/free endpoints
    else if (native[protocol]) {
      primaryUrl = native[protocol];
    }

    if (primaryUrl) {
      endpoints[protocol] = {
        native: primaryUrl,
        messari: null,
        config: PROTOCOL_CONFIG[protocol] || PROTOCOL_CONFIG.AAVE_V3,
      };
    }
  }

  return endpoints;
}

/**
 * Check if subgraph is available for a chain
 */
function hasSubgraphSupport(chainName) {
  const endpoints = getSubgraphsForChain(chainName);
  return Object.keys(endpoints).length > 0;
}

/**
 * Get query template for a protocol
 */
function getQueryTemplate(protocolType, queryName) {
  const config = PROTOCOL_CONFIG[protocolType];
  const templateKey = config?.queryTemplate || 'MESSARI';
  const templates = QUERY_TEMPLATES[templateKey];
  return templates?.[queryName] || QUERY_TEMPLATES.MESSARI[queryName];
}

module.exports = {
  MESSARI_SUBGRAPHS,
  NATIVE_SUBGRAPHS,
  DECENTRALIZED_SUBGRAPHS,
  ALCHEMY_SUBGRAPHS,
  QUERY_TEMPLATES,
  PROTOCOL_CONFIG,
  getSubgraphsForChain,
  getQueryTemplate,
  hasSubgraphSupport,
};

