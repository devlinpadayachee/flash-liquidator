// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title FlashLiquidator
 * @notice Zero-capital flash loan liquidation bot for DeFi lending protocols
 * @dev Uses Aave V3 flash loans to liquidate positions on any supported protocol
 *
 * Supported protocols:
 * - Aave V3 (Polygon, Arbitrum, Base, Avalanche)
 * - Compound V3 (Polygon, Arbitrum, Base)
 * - Venus (BSC)
 *
 * Flow:
 * 1. Flash borrow debt token from Aave
 * 2. Liquidate borrower's position on target protocol
 * 3. Receive collateral + liquidation bonus
 * 4. Swap collateral to debt token via DEX
 * 5. Repay flash loan + fee
 * 6. Keep profit
 */

// ============ INTERFACES ============

interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;

    function getUserAccountData(
        address user
    )
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

interface ICompoundV3 {
    function absorb(address absorber, address[] calldata accounts) external;
    function isLiquidatable(address account) external view returns (bool);
    function borrowBalanceOf(address account) external view returns (uint256);
}

interface IVenusComptroller {
    function liquidateBorrow(
        address borrower,
        uint256 repayAmount,
        address vTokenCollateral
    ) external returns (uint256);

    function getAccountLiquidity(
        address account
    )
        external
        view
        returns (uint256 error, uint256 liquidity, uint256 shortfall);
}

interface IVToken {
    function liquidateBorrow(
        address borrower,
        uint256 repayAmount,
        address vTokenCollateral
    ) external returns (uint256);

    function borrowBalanceCurrent(address account) external returns (uint256);
    function underlying() external view returns (address);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory amounts);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

// ============ MAIN CONTRACT ============

contract FlashLiquidator is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ STATE ============

    // Aave V3 Pool (source of flash loans)
    IAavePool public aavePool;

    // Default swap router
    IUniswapV2Router public swapRouter;

    // Wrapped native token (WMATIC, WETH, etc.)
    address public wrappedNative;

    // Minimum profit in debt token to execute (prevents unprofitable txs)
    uint256 public minProfitWei;

    // Flash loan fee (Aave V3 = 0.05% = 5 basis points)
    uint256 public constant FLASH_LOAN_FEE_BPS = 5;

    // ============ EVENTS ============

    event LiquidationExecuted(
        address indexed borrower,
        address indexed protocol,
        address debtToken,
        address collateralToken,
        uint256 debtRepaid,
        uint256 collateralReceived,
        uint256 profit,
        uint256 timestamp
    );

    event ProfitWithdrawn(
        address indexed token,
        uint256 amount,
        address indexed to
    );

    // ============ STRUCTS ============

    struct LiquidationParams {
        uint8 protocolType; // 0=Aave, 1=Compound, 2=Venus
        address protocol; // Protocol address (pool/comptroller)
        address borrower; // Who to liquidate
        address debtToken; // Token they owe
        address collateralToken; // Token they posted as collateral
        uint256 debtAmount; // How much debt to repay
        address swapRouter; // DEX router for collateral swap
        uint256 minProfit; // Minimum profit required
    }

    // ============ CONSTRUCTOR ============

    constructor(
        address _aavePool,
        address _swapRouter,
        address _wrappedNative
    ) Ownable(msg.sender) {
        aavePool = IAavePool(_aavePool);
        swapRouter = IUniswapV2Router(_swapRouter);
        wrappedNative = _wrappedNative;
        minProfitWei = 0; // Start with 0, can be set later
    }

    // ============ MAIN LIQUIDATION FUNCTION ============

    /**
     * @notice Execute a flash loan liquidation
     * @param params Liquidation parameters
     */
    function liquidate(
        LiquidationParams calldata params
    ) external nonReentrant {
        require(params.debtAmount > 0, "Debt amount must be > 0");
        require(params.borrower != address(0), "Invalid borrower");

        // Encode params for flash loan callback
        bytes memory data = abi.encode(params);

        // Request flash loan from Aave V3
        // This will call executeOperation() with the borrowed funds
        aavePool.flashLoanSimple(
            address(this),
            params.debtToken,
            params.debtAmount,
            data,
            0 // referral code
        );
    }

    /**
     * @notice Aave V3 flash loan callback
     * @dev Called by Aave pool after we receive the flash loan
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(aavePool), "Caller must be Aave Pool");
        require(initiator == address(this), "Initiator must be this contract");

        // Decode liquidation params
        LiquidationParams memory liqParams = abi.decode(
            params,
            (LiquidationParams)
        );

        // Calculate amount to repay (principal + fee)
        uint256 amountOwed = amount + premium;

        // Get collateral balance before liquidation
        uint256 collateralBefore = IERC20(liqParams.collateralToken).balanceOf(
            address(this)
        );

        // Execute liquidation based on protocol type
        if (liqParams.protocolType == 0) {
            _liquidateAave(liqParams, amount);
        } else if (liqParams.protocolType == 1) {
            _liquidateCompound(liqParams);
        } else if (liqParams.protocolType == 2) {
            _liquidateVenus(liqParams, amount);
        } else {
            revert("Unknown protocol type");
        }

        // Calculate collateral received
        uint256 collateralReceived = IERC20(liqParams.collateralToken)
            .balanceOf(address(this)) - collateralBefore;
        require(collateralReceived > 0, "No collateral received");

        // Swap collateral to debt token (if different)
        uint256 debtTokenReceived;
        if (liqParams.collateralToken != asset) {
            debtTokenReceived = _swapCollateral(
                liqParams.collateralToken,
                asset,
                collateralReceived,
                liqParams.swapRouter
            );
        } else {
            debtTokenReceived = collateralReceived;
        }

        // Verify we have enough to repay
        require(
            debtTokenReceived >= amountOwed,
            "Insufficient funds to repay flash loan"
        );

        // Calculate profit
        uint256 profit = debtTokenReceived - amountOwed;
        require(profit >= liqParams.minProfit, "Profit below minimum");

        // Approve Aave pool to take repayment
        IERC20(asset).safeIncreaseAllowance(address(aavePool), amountOwed);

        emit LiquidationExecuted(
            liqParams.borrower,
            liqParams.protocol,
            asset,
            liqParams.collateralToken,
            amount,
            collateralReceived,
            profit,
            block.timestamp
        );

        return true;
    }

    // ============ PROTOCOL-SPECIFIC LIQUIDATIONS ============

    /**
     * @notice Liquidate on Aave V3
     */
    function _liquidateAave(
        LiquidationParams memory params,
        uint256 debtAmount
    ) internal {
        // Approve debt token for liquidation
        IERC20(params.debtToken).safeIncreaseAllowance(
            params.protocol,
            debtAmount
        );

        // Execute liquidation on Aave
        // receiveAToken = false means we get the underlying collateral
        IAavePool(params.protocol).liquidationCall(
            params.collateralToken,
            params.debtToken,
            params.borrower,
            debtAmount,
            false // receive underlying, not aToken
        );
    }

    /**
     * @notice Liquidate on Compound V3
     * @dev Compound V3 uses "absorb" mechanism - collateral goes to protocol reserves
     *      We get a portion as liquidator discount
     */
    function _liquidateCompound(LiquidationParams memory params) internal {
        address[] memory accounts = new address[](1);
        accounts[0] = params.borrower;

        ICompoundV3(params.protocol).absorb(address(this), accounts);
    }

    /**
     * @notice Liquidate on Venus (BSC)
     */
    function _liquidateVenus(
        LiquidationParams memory params,
        uint256 debtAmount
    ) internal {
        // Get underlying token of vToken
        address underlying = IVToken(params.protocol).underlying();

        // Approve debt token for liquidation
        IERC20(underlying).safeIncreaseAllowance(params.protocol, debtAmount);

        // Execute liquidation
        // params.collateralToken here is the vToken of the collateral
        IVToken(params.protocol).liquidateBorrow(
            params.borrower,
            debtAmount,
            params.collateralToken
        );
    }

    // ============ SWAP FUNCTIONS ============

    /**
     * @notice Swap collateral token to debt token
     */
    function _swapCollateral(
        address fromToken,
        address toToken,
        uint256 amountIn,
        address router
    ) internal returns (uint256) {
        IUniswapV2Router routerContract = router == address(0)
            ? swapRouter
            : IUniswapV2Router(router);

        // Approve router
        IERC20(fromToken).safeIncreaseAllowance(
            address(routerContract),
            amountIn
        );

        // Build path (direct or through wrapped native)
        address[] memory path;
        if (fromToken == wrappedNative || toToken == wrappedNative) {
            path = new address[](2);
            path[0] = fromToken;
            path[1] = toToken;
        } else {
            // Route through wrapped native for better liquidity
            path = new address[](3);
            path[0] = fromToken;
            path[1] = wrappedNative;
            path[2] = toToken;
        }

        // Get expected output
        uint256[] memory amountsOut = routerContract.getAmountsOut(
            amountIn,
            path
        );
        uint256 expectedOut = amountsOut[amountsOut.length - 1];

        // Allow 1% slippage
        uint256 minOut = (expectedOut * 99) / 100;

        // Execute swap
        uint256[] memory amounts = routerContract.swapExactTokensForTokens(
            amountIn,
            minOut,
            path,
            address(this),
            block.timestamp + 300
        );

        return amounts[amounts.length - 1];
    }

    // ============ VIEW FUNCTIONS ============

    /**
     * @notice Check if a liquidation would be profitable
     * @return profitable Whether the liquidation would be profitable
     * @return estimatedProfit Estimated profit in debt token
     */
    function simulateLiquidation(
        LiquidationParams calldata params
    ) external pure returns (bool profitable, uint256 estimatedProfit) {
        // This is a simplified simulation - actual profitability depends on:
        // 1. Liquidation bonus from protocol
        // 2. Swap slippage
        // 3. Flash loan fee
        // 4. Gas costs (not included here)

        // Estimate: assume 5% liquidation bonus, 1% swap cost, 0.05% flash fee
        uint256 expectedCollateralValue = (params.debtAmount * 105) / 100; // 5% bonus
        uint256 afterSwap = (expectedCollateralValue * 99) / 100; // 1% swap cost
        uint256 flashFee = (params.debtAmount * FLASH_LOAN_FEE_BPS) / 10000;

        if (afterSwap > params.debtAmount + flashFee) {
            profitable = true;
            estimatedProfit = afterSwap - params.debtAmount - flashFee;
        } else {
            profitable = false;
            estimatedProfit = 0;
        }
    }

    /**
     * @notice Get health factor for Aave position
     */
    function getAaveHealthFactor(
        address pool,
        address user
    ) external view returns (uint256) {
        (, , , , , uint256 healthFactor) = IAavePool(pool).getUserAccountData(
            user
        );
        return healthFactor;
    }

    // ============ ADMIN FUNCTIONS ============

    /**
     * @notice Update Aave pool address
     */
    function setAavePool(address _aavePool) external onlyOwner {
        require(_aavePool != address(0), "Invalid address");
        aavePool = IAavePool(_aavePool);
    }

    /**
     * @notice Update default swap router
     */
    function setSwapRouter(address _router) external onlyOwner {
        require(_router != address(0), "Invalid address");
        swapRouter = IUniswapV2Router(_router);
    }

    /**
     * @notice Update wrapped native token
     */
    function setWrappedNative(address _wrappedNative) external onlyOwner {
        require(_wrappedNative != address(0), "Invalid address");
        wrappedNative = _wrappedNative;
    }

    /**
     * @notice Update minimum profit threshold
     */
    function setMinProfit(uint256 _minProfitWei) external onlyOwner {
        minProfitWei = _minProfitWei;
    }

    /**
     * @notice Withdraw accumulated profits
     */
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 withdrawAmount = amount == 0 ? balance : amount;
        require(withdrawAmount <= balance, "Insufficient balance");

        IERC20(token).safeTransfer(msg.sender, withdrawAmount);
        emit ProfitWithdrawn(token, withdrawAmount, msg.sender);
    }

    /**
     * @notice Withdraw native token (ETH/MATIC/BNB)
     */
    function withdrawNative() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No native balance");

        (bool success, ) = msg.sender.call{value: balance}("");
        require(success, "Transfer failed");
        emit ProfitWithdrawn(address(0), balance, msg.sender);
    }

    /**
     * @notice Emergency function to rescue stuck tokens
     */
    function emergencyWithdraw(
        address token,
        uint256 amount
    ) external onlyOwner {
        if (token == address(0)) {
            (bool success, ) = msg.sender.call{value: amount}("");
            require(success, "Transfer failed");
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
        }
    }

    // ============ RECEIVE ============

    receive() external payable {}
}
