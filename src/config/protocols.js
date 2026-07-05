/**
 * Lending Protocol Configuration
 *
 * Contains ABIs and helpers for interacting with:
 * - Aave V3
 * - Compound V3
 * - Venus
 * - Benqi
 */

// ============ AAVE V3 ABIs ============

const AAVE_POOL_ABI = [
  // Flash loan
  'function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external',

  // Liquidation
  'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external',

  // User data
  'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',

  // Reserve data
  'function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',

  // Events (required for event filtering)
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
  'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
  'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
];

const AAVE_POOL_DATA_PROVIDER_ABI = [
  // Get all reserves
  'function getAllReservesTokens() external view returns (tuple(string symbol, address tokenAddress)[])',

  // Get user reserve data
  'function getUserReserveData(address asset, address user) external view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',

  // Get reserve configuration
  'function getReserveConfigurationData(address asset) external view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
];

const AAVE_ORACLE_ABI = [
  'function getAssetPrice(address asset) external view returns (uint256)',
  'function getAssetsPrices(address[] calldata assets) external view returns (uint256[])',
];

// Events for discovering borrowers
const AAVE_POOL_EVENTS = [
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
  'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
  'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
];

// ============ COMPOUND V3 ABIs ============

const COMPOUND_V3_ABI = [
  // Check if liquidatable
  'function isLiquidatable(address account) external view returns (bool)',

  // Get borrow balance
  'function borrowBalanceOf(address account) external view returns (uint256)',

  // Absorb (liquidate)
  'function absorb(address absorber, address[] calldata accounts) external',

  // Get account info
  'function userBasic(address account) external view returns (int104 principal, uint64 baseTrackingIndex, uint64 baseTrackingAccrued, uint16 assetsIn)',
];

// ============ VENUS ABIs ============

const VENUS_COMPTROLLER_ABI = [
  // Get account liquidity
  'function getAccountLiquidity(address account) external view returns (uint256 error, uint256 liquidity, uint256 shortfall)',

  // Get all markets
  'function getAllMarkets() external view returns (address[])',

  // Close factor
  'function closeFactorMantissa() external view returns (uint256)',

  // Liquidation incentive
  'function liquidationIncentiveMantissa() external view returns (uint256)',
];

const VENUS_VTOKEN_ABI = [
  // Liquidate
  'function liquidateBorrow(address borrower, uint256 repayAmount, address vTokenCollateral) external returns (uint256)',

  // Get borrow balance
  'function borrowBalanceCurrent(address account) external returns (uint256)',
  'function borrowBalanceStored(address account) external view returns (uint256)',

  // Get underlying
  'function underlying() external view returns (address)',

  // Exchange rate
  'function exchangeRateStored() external view returns (uint256)',

  // Account snapshot
  'function getAccountSnapshot(address account) external view returns (uint256 error, uint256 vTokenBalance, uint256 borrowBalance, uint256 exchangeRateMantissa)',
];

const VENUS_ORACLE_ABI = [
  'function getUnderlyingPrice(address vToken) external view returns (uint256)',
];

// ============ BENQI ABIs (Compound-fork) ============

const BENQI_COMPTROLLER_ABI = VENUS_COMPTROLLER_ABI; // Same interface
const BENQI_QITOKEN_ABI = VENUS_VTOKEN_ABI; // Same interface

// ============ RADIANT ABIs (Aave-fork with better bonuses!) ============

const RADIANT_POOL_ABI = [
  // Same as Aave V3 but with different addresses
  'function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external',
  'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external',
  'function getUserAccountData(address user) external view returns (uint256 totalCollateralETH, uint256 totalDebtETH, uint256 availableBorrowsETH, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
];

// ============ MOONWELL ABIs (Compound-fork on Base) ============

const MOONWELL_COMPTROLLER_ABI = [
  'function getAccountLiquidity(address account) external view returns (uint256 error, uint256 liquidity, uint256 shortfall)',
  'function getAllMarkets() external view returns (address[])',
  'function closeFactorMantissa() external view returns (uint256)',
  'function liquidationIncentiveMantissa() external view returns (uint256)',
  'function markets(address cToken) external view returns (bool isListed, uint256 collateralFactorMantissa)',
];

const MOONWELL_MTOKEN_ABI = [
  'function liquidateBorrow(address borrower, uint256 repayAmount, address cTokenCollateral) external returns (uint256)',
  'function borrowBalanceCurrent(address account) external returns (uint256)',
  'function borrowBalanceStored(address account) external view returns (uint256)',
  'function underlying() external view returns (address)',
  'function exchangeRateStored() external view returns (uint256)',
  'function getAccountSnapshot(address account) external view returns (uint256 error, uint256 mTokenBalance, uint256 borrowBalance, uint256 exchangeRateMantissa)',
];

// ============ SEAMLESS ABIs (Native Base lending) ============

const SEAMLESS_POOL_ABI = AAVE_POOL_ABI; // Aave V3 fork

// ============ COMMON ABIs ============

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

const UNISWAP_V2_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)',
];

// ============ LIQUIDATION BONUS ============

// Liquidation bonuses by protocol (in basis points)
// These are the rewards you get for liquidating
// HIGHER BONUS = MORE PROFIT!
const LIQUIDATION_BONUSES = {
  RADIANT: {
    default: 1500, // 15%!!! Best bonuses in DeFi (Arbitrum)
  },
  VENUS: {
    default: 1000, // 10% (BSC)
  },
  BENQI: {
    default: 800, // 8% (Avalanche)
  },
  MOONWELL: {
    default: 800, // 8% (Base - less competition!)
  },
  AAVE_V3: {
    default: 500, // 5% (all chains)
    stablecoins: 450, // 4.5% for stables
    eth: 500,
    btc: 500,
  },
  SEAMLESS: {
    default: 500, // 5% (Base)
  },
  COMPOUND_V3: {
    default: 500, // 5%
  },
};

// ============ PROTOCOL TYPE ENUM ============

const PROTOCOL_TYPES = {
  AAVE_V3: 0,
  COMPOUND_V3: 1,
  VENUS: 2,
  BENQI: 3,
  RADIANT: 4,
  MOONWELL: 5,
  SEAMLESS: 6,
};

// ============ HELPERS ============

/**
 * Calculate health factor from Aave data
 * Health factor < 1e18 (1.0) means liquidatable
 */
function calculateAaveHealthFactor(totalCollateralBase, totalDebtBase, liquidationThreshold) {
  if (totalDebtBase === 0n) return BigInt('999999999999999999999'); // Infinite
  return (totalCollateralBase * liquidationThreshold) / totalDebtBase / 100n;
}

/**
 * Check if Venus account is liquidatable
 * Shortfall > 0 means liquidatable
 */
function isVenusLiquidatable(shortfall) {
  return shortfall > 0n;
}

/**
 * Calculate max liquidatable amount for Aave
 * Can liquidate up to 50% of debt
 */
function getMaxAaveLiquidation(totalDebt) {
  return totalDebt / 2n;
}

/**
 * Calculate max liquidatable amount for Venus
 * Close factor determines max (usually 50%)
 */
function getMaxVenusLiquidation(borrowBalance, closeFactorMantissa) {
  return (borrowBalance * closeFactorMantissa) / BigInt(1e18);
}

module.exports = {
  // Aave V3 ABIs
  AAVE_POOL_ABI,
  AAVE_POOL_DATA_PROVIDER_ABI,
  AAVE_ORACLE_ABI,
  AAVE_POOL_EVENTS,

  // Compound V3 ABIs
  COMPOUND_V3_ABI,

  // Venus ABIs (BSC)
  VENUS_COMPTROLLER_ABI,
  VENUS_VTOKEN_ABI,
  VENUS_ORACLE_ABI,

  // Benqi ABIs (Avalanche)
  BENQI_COMPTROLLER_ABI,
  BENQI_QITOKEN_ABI,

  // Radiant ABIs (Arbitrum - 15% bonus!)
  RADIANT_POOL_ABI,

  // Moonwell ABIs (Base - less competition!)
  MOONWELL_COMPTROLLER_ABI,
  MOONWELL_MTOKEN_ABI,

  // Seamless ABIs (Base)
  SEAMLESS_POOL_ABI,

  // Common ABIs
  ERC20_ABI,
  UNISWAP_V2_ROUTER_ABI,

  // Constants
  LIQUIDATION_BONUSES,
  PROTOCOL_TYPES,

  // Helpers
  calculateAaveHealthFactor,
  isVenusLiquidatable,
  getMaxAaveLiquidation,
  getMaxVenusLiquidation,
};

