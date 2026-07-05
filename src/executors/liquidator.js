/**
 * Liquidation Executor
 *
 * Executes flash loan liquidations with profitability checks.
 * Optimized for small, consistent profits.
 */

const { ethers } = require('ethers');
const {
  AAVE_POOL_DATA_PROVIDER_ABI,
  AAVE_ORACLE_ABI,
  ERC20_ABI,
  UNISWAP_V2_ROUTER_ABI,
  PROTOCOL_TYPES,
  LIQUIDATION_BONUSES,
} = require('../config/protocols');
const RouteQuoter = require('../utils/routeQuoter');

// FlashLiquidatorV2 contract ABI - Full JSON format for better encoding
const FLASH_LIQUIDATOR_ABI = [
  {
    "name": "liquidate",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [{
      "name": "params",
      "type": "tuple",
      "components": [
        { "name": "protocolType", "type": "uint8" },
        { "name": "swapMode", "type": "uint8" },
        { "name": "protocol", "type": "address" },
        { "name": "borrower", "type": "address" },
        { "name": "debtToken", "type": "address" },
        { "name": "collateralToken", "type": "address" },
        { "name": "debtAmount", "type": "uint256" },
        { "name": "swapRouter", "type": "address" },
        { "name": "swapPath", "type": "bytes" },
        { "name": "minOutRate", "type": "uint256" },
        { "name": "minProfit", "type": "uint256" }
      ]
    }],
    "outputs": []
  },
  "function withdrawToken(address token, uint256 amount) external",
  "function withdrawNative() external",
  "function owner() view returns (address)",
  "event LiquidationExecuted(address indexed borrower, address indexed protocol, address debtToken, address collateralToken, uint256 debtRepaid, uint256 collateralReceived, uint256 profit, uint256 timestamp)"
];

class Liquidator {
  constructor(chainConfig, provider, wallet, settings = {}) {
    this.chain = chainConfig;
    this.provider = provider;
    this.wallet = wallet;

    // Settings
    this.settings = {
      minProfitUSD: parseFloat(settings.minProfitUSD || process.env.MIN_PROFIT_USD || '2'),
      maxGasUSD: parseFloat(settings.maxGasUSD || process.env.MAX_GAS_USD || '5'),
      slippageBps: parseInt(settings.slippageBps || '100'), // 1% default slippage
      dryRun: settings.dryRun || process.env.DRY_RUN === 'true',
    };

    // Contract instances
    this.flashLiquidator = null;
    this.aaveDataProvider = null;
    this.aaveOracle = null;
    this.router = null;

    // Stats
    this.stats = {
      liquidationsAttempted: 0,
      liquidationsSuccessful: 0,
      liquidationsFailed: 0,
      totalProfitUSD: 0,
      totalGasSpentUSD: 0,
    };

    // Price cache (refresh every 60s)
    this.priceCache = new Map();
    this.priceCacheTime = 0;
  }

  /**
   * Initialize executor
   */
  async initialize(contractAddress) {
    console.log(`\n⚡ Initializing Liquidator...`);

    // Load flash liquidator contract
    if (contractAddress) {
      this.flashLiquidator = new ethers.Contract(
        contractAddress,
        FLASH_LIQUIDATOR_ABI,
        this.wallet
      );

      // Verify ownership
      try {
        const owner = await this.flashLiquidator.owner();
        if (owner.toLowerCase() !== this.wallet.address.toLowerCase()) {
          console.log(`   ⚠️ Warning: You are not the contract owner!`);
        } else {
          console.log(`   ✅ Contract: ${contractAddress.slice(0, 10)}...`);
        }
      } catch (err) {
        console.log(`   ❌ Failed to verify contract: ${err.message}`);
        return false;
      }
    } else {
      console.log(`   ⚠️ No contract address - running in simulation mode`);
      this.settings.dryRun = true;
    }

    // Initialize protocol helpers
    if (this.chain.aaveV3) {
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
    }

    // Initialize router
    this.router = new ethers.Contract(
      this.chain.defaultRouter,
      UNISWAP_V2_ROUTER_ABI,
      this.provider
    );

    // Multi-DEX route quoter (V2 routers + Uniswap V3)
    this.routeQuoter = new RouteQuoter(this.chain, this.provider);
    console.log(`   🔀 Multi-DEX routing: ${this.routeQuoter.v2Routers.length} V2 routers${this.routeQuoter.v3Router ? ' + Uniswap V3' : ''}`);

    console.log(`   💰 Min profit: $${this.settings.minProfitUSD}`);
    console.log(`   ⛽ Max gas: $${this.settings.maxGasUSD}`);
    console.log(`   🧪 Dry run: ${this.settings.dryRun}`);

    return true;
  }

  /**
   * Attempt to liquidate a position
   */
  async liquidate(position, gasSettings = null) {
    console.log(`\n🎯 Attempting liquidation...`);
    console.log(`   Borrower: ${position.address}`);
    console.log(`   Protocol: ${position.protocol}`);
    console.log(`   Health Factor: ${position.healthFactor?.toFixed(4)}`);
    console.log(`   Debt: $${position.totalDebtUSD?.toFixed(2)}`);

    // FIX: Reject invalid positions early
    if (!position.healthFactor || position.healthFactor <= 0.01) {
      console.log(`   ❌ Invalid health factor (${position.healthFactor}) - position likely closed`);
      return { success: false, reason: 'Invalid health factor (already liquidated or no debt)' };
    }

    if (position.healthFactor >= 1.0) {
      console.log(`   ❌ Position is healthy (HF >= 1.0)`);
      return { success: false, reason: 'Position is healthy' };
    }

    if (!position.totalDebtUSD || position.totalDebtUSD < 10) {
      console.log(`   ❌ Debt too small ($${position.totalDebtUSD?.toFixed(2) || 0})`);
      return { success: false, reason: 'Debt too small' };
    }

    this.stats.liquidationsAttempted++;

    try {
      // Step 1: Get detailed position info
      const details = await this.getPositionDetails(position);
      if (!details) {
        console.log(`   ❌ Could not get position details`);
        return { success: false, reason: 'No position details' };
      }

      console.log(`   Debt Token: ${details.debtSymbol} (${details.debtToken.slice(0, 10)}...)`);
      console.log(`   Collateral: ${details.collateralSymbol} (${details.collateralToken.slice(0, 10)}...)`);
      console.log(`   Debt Amount: ${details.debtAmount} ${details.debtSymbol}`);

      // Step 2: Calculate profitability
      const profitability = await this.calculateProfitability(details);
      if (!profitability.profitable) {
        console.log(`   ❌ Not profitable: ${profitability.reason}`);
        return { success: false, reason: profitability.reason };
      }

      console.log(`   ✅ Profitable!`);
      console.log(`      Estimated profit: $${profitability.estimatedProfitUSD.toFixed(2)}`);
      console.log(`      Gas cost: $${profitability.gasCostUSD.toFixed(2)}`);
      console.log(`      Net profit: $${profitability.netProfitUSD.toFixed(2)}`);

      // Step 3: Execute (or simulate)
      if (this.settings.dryRun) {
        console.log(`   🧪 DRY RUN - Would execute liquidation`);
        this.stats.liquidationsSuccessful++;
        this.stats.totalProfitUSD += profitability.netProfitUSD;
        return {
          success: true,
          simulated: true,
          profit: profitability.netProfitUSD,
        };
      }

      // Execute real liquidation
      const result = await this.executeLiquidation(details, profitability, gasSettings);

      if (result.success) {
        this.stats.liquidationsSuccessful++;
        this.stats.totalProfitUSD += result.profit || 0;
        this.stats.totalGasSpentUSD += result.gasSpent || 0;
      } else {
        this.stats.liquidationsFailed++;
      }

      return result;

    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      this.stats.liquidationsFailed++;
      return { success: false, reason: error.message };
    }
  }

  /**
   * Get current health factor in real-time (for pre-execution verification)
   */
  async getCurrentHealthFactor(borrower, protocolAddress) {
    try {
      // Aave V3 Pool getUserAccountData
      const pool = new ethers.Contract(
        protocolAddress,
        ['function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)'],
        this.provider
      );

      const data = await pool.getUserAccountData(borrower);
      const healthFactor = parseFloat(ethers.formatEther(data.healthFactor));
      const totalDebt = parseFloat(ethers.formatUnits(data.totalDebtBase, 8));

      // If no debt, position is closed
      if (totalDebt < 1) {
        return 0; // Signal closed position
      }

      return healthFactor;
    } catch (error) {
      console.log(`   ⚠️ HF verification error: ${error.message}`);
      return null;
    }
  }

  /**
   * Get detailed position information
   */
  async getPositionDetails(position) {
    try {
      if (position.protocol === 'AAVE_V3') {
        return await this.getAavePositionDetails(position);
      } else if (position.protocol === 'VENUS') {
        return await this.getVenusPositionDetails(position);
      }
      return null;
    } catch (error) {
      console.log(`   ⚠️ Position details error: ${error.message}`);
      return null;
    }
  }

  /**
   * Get Aave V3 position details
   */
  async getAavePositionDetails(position) {
    // Get all reserve tokens (cached - the reserve list rarely changes)
    if (!this._reservesCache) {
      this._reservesCache = await this.aaveDataProvider.getAllReservesTokens();
    }
    const reserves = this._reservesCache;

    let largestDebt = { token: null, amount: 0n, amountUSD: 0 };
    let largestCollateral = { token: null, amount: 0n, amountUSD: 0 };

    // Check reserves in parallel batches - the old sequential loop took long
    // enough that positions were gone by the time details were ready
    const BATCH = 10;
    const perReserve = [];
    for (let i = 0; i < reserves.length; i += BATCH) {
      const chunk = reserves.slice(i, i + BATCH);
      const results = await Promise.all(chunk.map(async (reserve) => {
        try {
          const [userData, config] = await Promise.all([
            this.aaveDataProvider.getUserReserveData(reserve.tokenAddress, position.address),
            this.aaveDataProvider.getReserveConfigurationData(reserve.tokenAddress),
          ]);

          const totalDebt = userData.currentVariableDebt + userData.currentStableDebt;
          const hasCollateral = userData.currentATokenBalance > 0n && userData.usageAsCollateralEnabled;
          if (totalDebt === 0n && !hasCollateral) return null;

          const price = await this.getTokenPrice(reserve.tokenAddress);
          return { reserve, userData, config, price, totalDebt, hasCollateral };
        } catch (err) {
          return null; // Skip reserve on error
        }
      }));
      perReserve.push(...results);
    }

    for (const r of perReserve) {
      if (!r) continue;
      const { reserve, userData, config, price, totalDebt, hasCollateral } = r;
      const decimals = Number(config.decimals);

      // Check debt (variable + stable)
      if (totalDebt > 0n) {
        const debtFloat = parseFloat(ethers.formatUnits(totalDebt, decimals));
        const debtUSD = debtFloat * price;

        if (debtUSD > largestDebt.amountUSD) {
          largestDebt = {
            token: reserve.tokenAddress,
            symbol: reserve.symbol,
            amount: totalDebt,
            amountFloat: debtFloat,
            amountUSD: debtUSD,
            decimals,
          };
        }
      }

      // Check collateral
      if (hasCollateral) {
        const collFloat = parseFloat(ethers.formatUnits(userData.currentATokenBalance, decimals));
        const collUSD = collFloat * price;

        if (collUSD > largestCollateral.amountUSD) {
          largestCollateral = {
            token: reserve.tokenAddress,
            symbol: reserve.symbol,
            amount: userData.currentATokenBalance,
            amountFloat: collFloat,
            amountUSD: collUSD,
            decimals,
            liquidationBonus: Number(config.liquidationBonus) / 10000, // e.g., 10500 = 105% = 5% bonus
          };
        }
      }
    }

    if (!largestDebt.token || !largestCollateral.token) {
      return null;
    }

    // Aave v3.3+ dust rule (MustNotLeaveDust, verified on fork): a partial
    // liquidation may not leave a debt/collateral remainder below ~$1000, so
    // positions under the $2000 close-factor threshold (or HF < 0.95) must be
    // liquidated 100%. 50%-of-small-debt reverts every time.
    const fullLiquidation = largestDebt.amountUSD <= 2000 || position.healthFactor < 0.95;
    // +0.1% buffer on full liquidation covers interest accrued since reading
    // the debt; liquidationCall caps to actual debt and the contract's
    // balance-delta accounting returns the unused flash loan.
    const maxLiquidatableAmount = fullLiquidation
      ? (largestDebt.amount * 1001n) / 1000n
      : largestDebt.amount / 2n;
    const maxLiquidatableUSD = fullLiquidation
      ? largestDebt.amountUSD
      : largestDebt.amountUSD / 2;

    return {
      borrower: position.address,
      protocol: 'AAVE_V3',
      protocolType: PROTOCOL_TYPES.AAVE_V3,
      protocolAddress: this.chain.aaveV3.pool,

      debtToken: largestDebt.token,
      debtSymbol: largestDebt.symbol,
      debtAmount: largestDebt.amountFloat,
      debtAmountWei: largestDebt.amount,
      debtUSD: largestDebt.amountUSD,
      debtDecimals: largestDebt.decimals,

      collateralToken: largestCollateral.token,
      collateralSymbol: largestCollateral.symbol,
      collateralAmount: largestCollateral.amountFloat,
      collateralAmountWei: largestCollateral.amount,
      collateralUSD: largestCollateral.amountUSD,
      collateralDecimals: largestCollateral.decimals,
      liquidationBonus: largestCollateral.liquidationBonus - 1, // Convert 1.05 to 0.05

      maxLiquidatableAmount,
      maxLiquidatableUSD,

      healthFactor: position.healthFactor,
    };
  }

  /**
   * Get Venus position details (simplified)
   */
  async getVenusPositionDetails(position) {
    // Venus is more complex - simplified for now
    // Would need to iterate through vTokens
    return null;
  }

  /**
   * Calculate if liquidation is profitable
   */
  async calculateProfitability(details) {
    try {
      // Get current gas price
      const feeData = await this.provider.getFeeData();
      const gasPrice = feeData.gasPrice || ethers.parseUnits('50', 'gwei');

      // Estimate gas for liquidation (flash loan tx is complex)
      const estimatedGas = 500000n;
      const gasCostWei = gasPrice * estimatedGas;
      const gasCostNative = parseFloat(ethers.formatEther(gasCostWei));

      // Get native token price
      const nativePrice = await this.getNativeTokenPrice();
      const gasCostUSD = gasCostNative * nativePrice;

      // Check gas limit
      if (gasCostUSD > this.settings.maxGasUSD) {
        return {
          profitable: false,
          reason: `Gas too high: $${gasCostUSD.toFixed(2)} > $${this.settings.maxGasUSD}`,
        };
      }

      // Calculate liquidation proceeds (sizing already dust-rule aware)
      const debtToLiquidateUSD = details.maxLiquidatableUSD;
      const collateralReceivedUSD = debtToLiquidateUSD * (1 + details.liquidationBonus);

      // Account for swap slippage
      const slippageFactor = 1 - (this.settings.slippageBps / 10000);
      const afterSwapUSD = collateralReceivedUSD * slippageFactor;

      // Flash loan fee (0.05% for Aave V3)
      const flashLoanFee = debtToLiquidateUSD * 0.0005;

      // Gross profit
      const grossProfitUSD = afterSwapUSD - debtToLiquidateUSD - flashLoanFee;

      // Net profit after gas
      const netProfitUSD = grossProfitUSD - gasCostUSD;

      // Check profitability
      if (netProfitUSD < this.settings.minProfitUSD) {
        return {
          profitable: false,
          reason: `Profit too low: $${netProfitUSD.toFixed(2)} < $${this.settings.minProfitUSD}`,
          estimatedProfitUSD: grossProfitUSD,
          gasCostUSD,
          netProfitUSD,
        };
      }

      return {
        profitable: true,
        debtToLiquidateUSD,
        collateralReceivedUSD,
        flashLoanFee,
        estimatedProfitUSD: grossProfitUSD,
        gasCostUSD,
        netProfitUSD,
        gasPrice,
        estimatedGas,
      };

    } catch (error) {
      return {
        profitable: false,
        reason: `Calculation error: ${error.message}`,
      };
    }
  }

  /**
   * Execute the actual liquidation
   */
  async executeLiquidation(details, profitability, gasSettings = null) {
    try {
      // Validate all required fields
      if (!details.protocolAddress) throw new Error('Missing protocolAddress');
      if (!details.borrower) throw new Error('Missing borrower');
      if (!details.debtToken) throw new Error('Missing debtToken');
      if (!details.collateralToken) throw new Error('Missing collateralToken');
      if (!details.maxLiquidatableAmount || details.maxLiquidatableAmount <= 0n) throw new Error('Invalid debtAmount');
      if (!this.chain.defaultRouter) throw new Error('Missing defaultRouter');

      // ⚠️ CRITICAL: Real-time HF check before spending gas!
      // Position may have been liquidated or recovered since detection
      console.log(`   🔍 Verifying position is still liquidatable...`);
      const currentHF = await this.getCurrentHealthFactor(details.borrower, details.protocolAddress);

      if (currentHF === null) {
        console.log(`   ❌ Could not verify health factor - position may be closed`);
        return { success: false, reason: 'Position verification failed (may be already liquidated)' };
      }

      if (currentHF >= 1.0) {
        console.log(`   ❌ Position recovered! Current HF: ${currentHF.toFixed(4)} (was: ${details.healthFactor?.toFixed(4)})`);
        return { success: false, reason: `Position recovered (HF: ${currentHF.toFixed(4)})` };
      }

      if (currentHF <= 0.01) {
        console.log(`   ❌ Position already liquidated! HF: ${currentHF}`);
        return { success: false, reason: 'Position already liquidated (HF=0)' };
      }

      console.log(`   ✅ Position verified liquidatable (HF: ${currentHF.toFixed(4)})`);
      details.healthFactor = currentHF; // Update with latest

      // Verify contract is initialized
      if (!this.flashLiquidator) {
        throw new Error('Flash liquidator contract not initialized');
      }

      // Enforce min profit ON-CHAIN: convert MIN_PROFIT_USD to debt-token units.
      // The contract reverts with "Profit below minimum" if the real proceeds
      // (after swap slippage and flash fee) don't clear this floor.
      let minProfitWei = 0n;
      const debtPrice = await this.getTokenPrice(details.debtToken);
      if (debtPrice > 0) {
        const minProfitTokens = this.settings.minProfitUSD / debtPrice;
        minProfitWei = ethers.parseUnits(
          minProfitTokens.toFixed(Math.min(details.debtDecimals, 8)),
          details.debtDecimals
        );
      }

      // Quote the best swap route (V2 routers + Uniswap V3) for the
      // collateral we expect to seize
      let route = null;
      if (details.collateralToken.toLowerCase() !== details.debtToken.toLowerCase()) {
        const collPrice = await this.getTokenPrice(details.collateralToken);
        const seizeUSD = Math.min(
          details.maxLiquidatableUSD * (1 + details.liquidationBonus),
          details.collateralUSD
        );
        const amountInEst = ethers.parseUnits(
          (seizeUSD / collPrice).toFixed(Math.min(details.collateralDecimals, 8)),
          details.collateralDecimals
        );

        route = await this.routeQuoter.quoteBestRoute(
          details.collateralToken,
          details.debtToken,
          amountInEst,
          parseFloat(process.env.SLIPPAGE_PERCENT || '1')
        );

        if (!route) {
          console.log(`   ❌ No swap route with liquidity for ${details.collateralSymbol} -> ${details.debtSymbol}`);
          return { success: false, reason: 'No swap route with liquidity' };
        }

        const outUSD = parseFloat(ethers.formatUnits(route.amountOut, details.debtDecimals)) * (await this.getTokenPrice(details.debtToken));
        console.log(`   🔀 Best route: ${route.label} -> $${outUSD.toFixed(2)} (of $${seizeUSD.toFixed(2)} seized)`);
      }

      // Build liquidation params as an OBJECT with named properties
      // This works better with ethers.js v6 JSON ABI
      const params = {
        protocolType: details.protocolType,
        swapMode: route ? route.swapMode : 0,
        protocol: details.protocolAddress,
        borrower: details.borrower,
        debtToken: details.debtToken,
        collateralToken: details.collateralToken,
        debtAmount: details.maxLiquidatableAmount,
        swapRouter: route ? route.swapRouter : this.chain.defaultRouter,
        swapPath: route ? route.swapPath : '0x',
        minOutRate: route ? route.minOutRate : 0n,
        minProfit: minProfitWei,
      };

      // TRUE dry-run: estimateGas executes the full flash loan -> liquidation ->
      // swap -> repay path against the current state. If it would revert for ANY
      // reason (HF recovered, bad swap route, profit below minimum), it fails
      // here and we spend zero gas. It also gives us an accurate gas limit.
      console.log(`   🧪 Simulating full liquidation on-chain (estimateGas)...`);
      let gasLimit;
      try {
        const gasEstimate = await this.flashLiquidator.liquidate.estimateGas(params);
        gasLimit = (gasEstimate * 130n) / 100n; // 30% buffer
        console.log(`   ✅ Simulation passed (estimated gas: ${gasEstimate.toString()})`);
      } catch (simError) {
        let reason = String(simError.reason || simError.shortMessage || simError.message || 'unknown').slice(0, 140);

        // Aave v3.x reverts with custom errors - decode known selectors
        // (verified live: healthy position returns 0x930bb771)
        const AAVE_ERRORS = {
          [ethers.id('HealthFactorNotBelowThreshold()').slice(0, 10)]: 'HealthFactorNotBelowThreshold',
          [ethers.id('CollateralCannotBeLiquidated()').slice(0, 10)]: 'CollateralCannotBeLiquidated',
          [ethers.id('SpecifiedCurrencyNotBorrowedByUser()').slice(0, 10)]: 'SpecifiedCurrencyNotBorrowedByUser',
          [ethers.id('MustNotLeaveDust()').slice(0, 10)]: 'MustNotLeaveDust',
          [ethers.id('MustNotLeaveDustyPosition()').slice(0, 10)]: 'MustNotLeaveDustyPosition',
          [ethers.id('ReservePaused()').slice(0, 10)]: 'ReservePaused',
          [ethers.id('ReserveInactive()').slice(0, 10)]: 'ReserveInactive',
        };
        const errData = simError.data || simError.info?.error?.data || null;
        const decoded = typeof errData === 'string' ? AAVE_ERRORS[errData.slice(0, 10)] : null;
        if (decoded) reason = decoded;

        console.log(`   ❌ Simulation reverted: ${reason}`);

        if (decoded === 'HealthFactorNotBelowThreshold' || reason.includes("'45'") || reason.toLowerCase().includes('health factor')) {
          return { success: false, reason: 'Position is healthy (HF above threshold)' };
        }
        if (decoded === 'SpecifiedCurrencyNotBorrowedByUser' || decoded === 'CollateralCannotBeLiquidated') {
          return { success: false, reason: `Position changed - already liquidated or repaid (${reason})` };
        }
        if (reason.includes('Profit below minimum')) {
          return { success: false, reason: `Not profitable on-chain after slippage (${reason})` };
        }
        return { success: false, reason: `Simulation reverted: ${reason}` };
      }

      console.log(`   🚀 Sending liquidation transaction...`);
      console.log(`      Protocol: ${details.protocol} (type: ${details.protocolType})`);
      console.log(`      Protocol Address: ${details.protocolAddress}`);
      console.log(`      Borrower: ${details.borrower}`);
      console.log(`      Debt: ${details.debtSymbol} (${details.debtToken})`);
      console.log(`      Collateral: ${details.collateralSymbol} (${details.collateralToken})`);
      console.log(`      Amount: ${ethers.formatUnits(details.maxLiquidatableAmount, details.debtDecimals)} ${details.debtSymbol}`);
      console.log(`      Swap Route: ${route ? route.label : 'none (collateral == debt)'} via ${params.swapRouter}`);

      // Apply the gas bid so we actually outbid competitors instead of
      // sending at default gas price (previously gasSettings was computed
      // by GasBidder but silently dropped).
      const txOverrides = { gasLimit };
      if (gasSettings?.maxFeePerGas && gasSettings?.maxPriorityFeePerGas) {
        txOverrides.maxFeePerGas = gasSettings.maxFeePerGas;
        txOverrides.maxPriorityFeePerGas = gasSettings.maxPriorityFeePerGas;
      }

      // Send transaction with properly encoded params
      const tx = await this.flashLiquidator.liquidate(params, txOverrides);

      console.log(`   ⏳ Tx sent: ${tx.hash}`);

      // Wait for confirmation
      const receipt = await tx.wait();

      if (receipt.status !== 1) {
        console.log(`   ❌ Transaction reverted`);
        return { success: false, reason: 'Transaction reverted' };
      }

      // Calculate actual gas spent
      const gasUsed = receipt.gasUsed;
      const effectiveGasPrice = receipt.gasPrice || profitability.gasPrice;
      const gasSpentWei = gasUsed * effectiveGasPrice;
      const gasSpentNative = parseFloat(ethers.formatEther(gasSpentWei));
      const nativePrice = await this.getNativeTokenPrice();
      const gasSpentUSD = gasSpentNative * nativePrice;

      // Try to parse profit from events
      let actualProfit = profitability.netProfitUSD; // Estimate if can't parse

      for (const log of receipt.logs) {
        try {
          const parsed = this.flashLiquidator.interface.parseLog(log);
          if (parsed?.name === 'LiquidationExecuted') {
            const profitWei = parsed.args.profit;
            // Profit is in debt token - convert to USD
            const profitFloat = parseFloat(ethers.formatUnits(profitWei, details.debtDecimals));
            const price = await this.getTokenPrice(details.debtToken);
            actualProfit = profitFloat * price - gasSpentUSD;
            break;
          }
        } catch (err) {
          // Not our event
        }
      }

      console.log(`   ✅ LIQUIDATION SUCCESSFUL!`);
      console.log(`      Tx: ${receipt.hash}`);
      console.log(`      Gas used: ${gasUsed.toString()}`);
      console.log(`      Gas cost: $${gasSpentUSD.toFixed(2)}`);
      console.log(`      Profit: $${actualProfit.toFixed(2)}`);

      return {
        success: true,
        txHash: receipt.hash,
        gasUsed: gasUsed.toString(),
        gasSpent: gasSpentUSD,
        profit: actualProfit,
      };

    } catch (error) {
      console.log(`   ❌ Execution error: ${error.message}`);
      return { success: false, reason: error.message };
    }
  }

  /**
   * Get token price in USD
   */
  async getTokenPrice(tokenAddress) {
    // Check cache
    const cached = this.priceCache.get(tokenAddress.toLowerCase());
    if (cached && Date.now() - this.priceCacheTime < 60000) {
      return cached;
    }

    try {
      // Try Aave oracle first
      if (this.aaveOracle) {
        const price = await this.aaveOracle.getAssetPrice(tokenAddress);
        // Aave oracle returns price in USD with 8 decimals
        const priceUSD = parseFloat(ethers.formatUnits(price, 8));
        this.priceCache.set(tokenAddress.toLowerCase(), priceUSD);
        this.priceCacheTime = Date.now();
        return priceUSD;
      }

      // Fallback: use DEX to estimate
      return 1; // Default to 1 for stablecoins

    } catch (error) {
      return 1; // Default
    }
  }

  /**
   * Get native token price (ETH/MATIC/etc)
   */
  async getNativeTokenPrice() {
    return await this.getTokenPrice(this.chain.wrappedNative);
  }

  /**
   * Withdraw profits from contract
   */
  async withdrawProfits(tokenAddress = null) {
    if (!this.flashLiquidator) {
      console.log(`No contract to withdraw from`);
      return false;
    }

    try {
      if (tokenAddress) {
        console.log(`Withdrawing ${tokenAddress}...`);
        const tx = await this.flashLiquidator.withdrawToken(tokenAddress, 0);
        await tx.wait();
      } else {
        console.log(`Withdrawing native token...`);
        const tx = await this.flashLiquidator.withdrawNative();
        await tx.wait();
      }
      console.log(`✅ Withdrawal complete`);
      return true;
    } catch (error) {
      console.log(`❌ Withdrawal failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      ...this.stats,
      successRate: this.stats.liquidationsAttempted > 0
        ? (this.stats.liquidationsSuccessful / this.stats.liquidationsAttempted * 100).toFixed(1)
        : '0',
    };
  }
}

module.exports = Liquidator;

