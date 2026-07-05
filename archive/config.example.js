/**
 * FLASH LIQUIDATOR - CONFIGURATION EXAMPLE
 *
 * Copy the values below to your .env file:
 *
 * ============ REQUIRED ============
 * PRIVATE_KEY=your_private_key_here
 *
 * ============ CHAIN SELECTION ============
 * # Options: POLYGON, ARBITRUM, BASE, BSC, AVALANCHE
 * # RECOMMENDATION: Start with BASE - less competition!
 * CHAIN=BASE
 *
 * ============ RPC ENDPOINTS ============
 * # Get free RPCs from: Alchemy, Infura, QuickNode
 * POLYGON_RPC_URL=https://polygon-rpc.com
 * ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
 * BASE_RPC_URL=https://mainnet.base.org
 * BSC_RPC_URL=https://bsc-dataseed.binance.org
 * AVALANCHE_RPC_URL=https://api.avax.network/ext/bc/C/rpc
 *
 * ============ CONTRACT ADDRESSES ============
 * # After deploying, add your contract addresses here
 * # Deploy with: npm run deploy:base (or deploy:polygon, etc)
 * POLYGON_CONTRACT_ADDRESS=
 * ARBITRUM_CONTRACT_ADDRESS=
 * BASE_CONTRACT_ADDRESS=
 * BSC_CONTRACT_ADDRESS=
 * AVALANCHE_CONTRACT_ADDRESS=
 *
 * ============ BOT SETTINGS ============
 * # Minimum profit in USD (lower = more opportunities, but more gas risk)
 * MIN_PROFIT_USD=2
 *
 * # Maximum gas to spend per liquidation in USD
 * MAX_GAS_USD=5
 *
 * # Target SMALL liquidations that big bots skip!
 * # This is your competitive advantage
 * MIN_DEBT_USD=50
 * MAX_DEBT_USD=5000
 *
 * # Health factor threshold to start watching (1.1 = 10% buffer)
 * WATCH_THRESHOLD=1.15
 *
 * # How often to scan for new borrowers (seconds)
 * SCAN_INTERVAL=300
 *
 * # How often to check health factors (seconds)
 * HEALTH_CHECK_INTERVAL=30
 *
 * ============ MEV PROTECTION (IMPORTANT!) ============
 * # Enable to prevent frontrunning - submits to private mempools
 * USE_MEV_PROTECTION=true
 *
 * ============ SMART GAS BIDDING ============
 * # Max % of expected profit to spend on gas
 * MAX_GAS_PROFIT_PERCENT=30
 *
 * # Minimum priority fee boost (gwei)
 * MIN_PRIORITY_BOOST=1
 *
 * # Maximum priority fee (gwei)
 * MAX_PRIORITY_FEE=50
 *
 * # Gas multiplier for urgent liquidations
 * URGENT_GAS_MULTIPLIER=1.5
 *
 * ============ PRICE MONITORING ============
 * # Alert on price drops (liquidation opportunities!)
 * PRICE_DROP_ALERT=5
 * PRICE_CHECK_INTERVAL=30
 *
 * ============ TELEGRAM ALERTS (Optional) ============
 * # Get instant notifications on your phone!
 * TELEGRAM_BOT_TOKEN=
 * TELEGRAM_CHAT_ID=
 *
 * ============ LOGGING ============
 * LOG_LEVEL=info
 * DRY_RUN=false
 */

// Default configuration values (used if env vars not set)
module.exports = {
  // Bot settings optimized for small, consistent profits
  MIN_PROFIT_USD: 2, // $2 minimum - catches small opportunities
  MAX_GAS_USD: 5, // Don't spend more than $5 on gas
  MIN_DEBT_USD: 50, // Minimum debt size to liquidate
  MAX_DEBT_USD: 5000, // Maximum debt - big bots target above this
  WATCH_THRESHOLD: 1.15, // Start watching when HF < 1.15
  SCAN_INTERVAL: 300, // Scan for new borrowers every 5 min
  HEALTH_CHECK_INTERVAL: 30, // Check HF every 30 seconds

  // MEV Protection - RECOMMENDED
  USE_MEV_PROTECTION: true,

  // Smart Gas Bidding
  MAX_GAS_PROFIT_PERCENT: 30,
  MIN_PRIORITY_BOOST: 1,
  MAX_PRIORITY_FEE: 50,
  URGENT_GAS_MULTIPLIER: 1.5,

  // Price Monitoring
  PRICE_DROP_ALERT: 5,
  PRICE_CHECK_INTERVAL: 30,

  // Supported chains (with competition level)
  SUPPORTED_CHAINS: [
    "BASE",      // LOW competition - recommended for beginners!
    "POLYGON",   // MEDIUM competition
    "ARBITRUM",  // MEDIUM competition (Radiant has good bonuses)
    "AVALANCHE", // MEDIUM competition
    "BSC",       // HIGH competition
  ],

  // Default chain - BASE has less competition
  DEFAULT_CHAIN: "BASE",

  // Protocols with good liquidation bonuses
  RECOMMENDED_PROTOCOLS: {
    RADIANT: "15% bonus (Arbitrum)",
    MOONWELL: "8% bonus (Base)",
    AAVE_V3: "5% bonus (all chains)",
    SEAMLESS: "5% bonus (Base)",
  },
};
