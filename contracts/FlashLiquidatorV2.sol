// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title FlashLiquidatorV2
 * @notice Zero-capital flash loan liquidation bot for DeFi lending protocols
 * @dev V2 adds Uniswap V3 swap support and off-chain-quoted slippage floors.
 *      The V1 contract could only swap through UniswapV2-style routers with a
 *      hardcoded path through wrapped native - on chains where V2 liquidity is
 *      thin, otherwise-profitable liquidations failed the repay check.
 *
 * Flow:
 * 1. Flash borrow debt token from Aave
 * 2. Liquidate borrower's position on target protocol
 * 3. Receive collateral + liquidation bonus
 * 4. Swap collateral to debt token via the router/path chosen off-chain
 * 5. Repay flash loan + fee
 * 6. Keep profit (enforced >= minProfit)
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
}

interface ICompoundV3 {
    function absorb(address absorber, address[] calldata accounts) external;
}

interface IVToken {
    function liquidateBorrow(
        address borrower,
        uint256 repayAmount,
        address vTokenCollateral
    ) external returns (uint256);

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

interface ISwapRouterV3 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(
        ExactInputParams calldata params
    ) external payable returns (uint256 amountOut);
}

// ============ MAIN CONTRACT ============

contract FlashLiquidatorV2 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ STATE ============

    // Aave V3 Pool (source of flash loans)
    IAavePool public aavePool;

    // Default V2-style swap router (fallback when params.swapRouter == 0)
    IUniswapV2Router public defaultRouter;

    // Wrapped native token (WPOL, WETH, etc.) for auto V2 path routing
    address public wrappedNative;

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
        uint8 protocolType; // 0=Aave V3, 1=Compound V3, 2=Venus
        uint8 swapMode; // 0=UniswapV2 router, 1=UniswapV3 router
        address protocol; // Protocol address (pool/comptroller/vToken)
        address borrower; // Who to liquidate
        address debtToken; // Token they owe
        address collateralToken; // Token they posted as collateral
        uint256 debtAmount; // How much debt to repay
        address swapRouter; // DEX router for collateral swap
        bytes swapPath; // V2: abi.encode(address[]) or empty for auto; V3: packed path
        uint256 minOutRate; // Min debt token out per 1e18 collateral in (scales with actual amount; 0 = V2 on-chain quote -1%)
        uint256 minProfit; // Minimum profit in debt token required
    }

    // ============ CONSTRUCTOR ============

    constructor(
        address _aavePool,
        address _defaultRouter,
        address _wrappedNative
    ) Ownable(msg.sender) {
        aavePool = IAavePool(_aavePool);
        defaultRouter = IUniswapV2Router(_defaultRouter);
        wrappedNative = _wrappedNative;
    }

    // ============ MAIN LIQUIDATION FUNCTION ============

    /**
     * @notice Execute a flash loan liquidation
     */
    function liquidate(
        LiquidationParams calldata params
    ) external nonReentrant {
        require(params.debtAmount > 0, "Debt amount must be > 0");
        require(params.borrower != address(0), "Invalid borrower");

        bytes memory data = abi.encode(params);

        // Request flash loan from Aave V3; calls executeOperation() back
        aavePool.flashLoanSimple(
            address(this),
            params.debtToken,
            params.debtAmount,
            data,
            0
        );
    }

    /**
     * @notice Aave V3 flash loan callback
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

        LiquidationParams memory liqParams = abi.decode(
            params,
            (LiquidationParams)
        );

        uint256 amountOwed = amount + premium;

        // Balance-delta accounting: liquidationCall may use LESS debt token
        // than we flash-borrowed (Aave caps debtToCover, e.g. 100%-liquidation
        // of small positions where exact debt grows with interest). Leftover
        // flash-loaned funds must count toward repayment, not be ignored.
        uint256 debtBalBefore = IERC20(asset).balanceOf(address(this)); // includes flash loan

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

        uint256 collateralReceived = IERC20(liqParams.collateralToken)
            .balanceOf(address(this)) - collateralBefore;
        require(collateralReceived > 0, "No collateral received");

        // Swap collateral to debt token (if different)
        if (liqParams.collateralToken != asset) {
            _swapCollateral(liqParams, collateralReceived);
        }

        uint256 debtBalAfter = IERC20(asset).balanceOf(address(this));
        require(
            debtBalAfter >= amountOwed,
            "Insufficient funds to repay flash loan"
        );

        // profit = (swap proceeds) - (debt actually repaid) - premium,
        // expressed via balance deltas so unused flash-loan funds cancel out.
        // Checked math reverts on a net loss even if repayment is possible.
        uint256 profit = (debtBalAfter + amount) - debtBalBefore - amountOwed;
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

    function _liquidateAave(
        LiquidationParams memory params,
        uint256 debtAmount
    ) internal {
        IERC20(params.debtToken).safeIncreaseAllowance(
            params.protocol,
            debtAmount
        );

        IAavePool(params.protocol).liquidationCall(
            params.collateralToken,
            params.debtToken,
            params.borrower,
            debtAmount,
            false // receive underlying, not aToken
        );
    }

    function _liquidateCompound(LiquidationParams memory params) internal {
        address[] memory accounts = new address[](1);
        accounts[0] = params.borrower;
        ICompoundV3(params.protocol).absorb(address(this), accounts);
    }

    function _liquidateVenus(
        LiquidationParams memory params,
        uint256 debtAmount
    ) internal {
        address underlying = IVToken(params.protocol).underlying();
        IERC20(underlying).safeIncreaseAllowance(params.protocol, debtAmount);
        IVToken(params.protocol).liquidateBorrow(
            params.borrower,
            debtAmount,
            params.collateralToken
        );
    }

    // ============ SWAP FUNCTIONS ============

    /**
     * @notice Swap all received collateral to the debt token using the
     *         router/path selected off-chain.
     */
    function _swapCollateral(
        LiquidationParams memory p,
        uint256 amountIn
    ) internal returns (uint256) {
        // Slippage floor scaled to the collateral actually being swapped
        uint256 scaledMinOut = (amountIn * p.minOutRate) / 1e18;

        if (p.swapMode == 1) {
            // ---- Uniswap V3 ----
            require(p.swapPath.length >= 43, "V3 path required");
            require(p.swapRouter != address(0), "V3 router required");

            IERC20(p.collateralToken).safeIncreaseAllowance(
                p.swapRouter,
                amountIn
            );

            return
                ISwapRouterV3(p.swapRouter).exactInput(
                    ISwapRouterV3.ExactInputParams({
                        path: p.swapPath,
                        recipient: address(this),
                        deadline: block.timestamp + 300,
                        amountIn: amountIn,
                        amountOutMinimum: scaledMinOut
                    })
                );
        }

        // ---- Uniswap V2 style ----
        IUniswapV2Router router = p.swapRouter == address(0)
            ? defaultRouter
            : IUniswapV2Router(p.swapRouter);

        IERC20(p.collateralToken).safeIncreaseAllowance(
            address(router),
            amountIn
        );

        // Explicit path from off-chain, or auto-route through wrapped native
        address[] memory path;
        if (p.swapPath.length > 0) {
            path = abi.decode(p.swapPath, (address[]));
        } else if (
            p.collateralToken == wrappedNative || p.debtToken == wrappedNative
        ) {
            path = new address[](2);
            path[0] = p.collateralToken;
            path[1] = p.debtToken;
        } else {
            path = new address[](3);
            path[0] = p.collateralToken;
            path[1] = wrappedNative;
            path[2] = p.debtToken;
        }

        // Slippage floor: off-chain rate if provided, else on-chain quote -1%
        uint256 minOut = scaledMinOut;
        if (minOut == 0) {
            uint256[] memory amountsOut = router.getAmountsOut(amountIn, path);
            minOut = (amountsOut[amountsOut.length - 1] * 99) / 100;
        }

        uint256[] memory amounts = router.swapExactTokensForTokens(
            amountIn,
            minOut,
            path,
            address(this),
            block.timestamp + 300
        );

        return amounts[amounts.length - 1];
    }

    // ============ ADMIN FUNCTIONS ============

    function setAavePool(address _aavePool) external onlyOwner {
        require(_aavePool != address(0), "Invalid address");
        aavePool = IAavePool(_aavePool);
    }

    function setDefaultRouter(address _router) external onlyOwner {
        require(_router != address(0), "Invalid address");
        defaultRouter = IUniswapV2Router(_router);
    }

    function setWrappedNative(address _wrappedNative) external onlyOwner {
        require(_wrappedNative != address(0), "Invalid address");
        wrappedNative = _wrappedNative;
    }

    /**
     * @notice Withdraw accumulated profits (amount == 0 withdraws everything)
     */
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 withdrawAmount = amount == 0 ? balance : amount;
        require(withdrawAmount <= balance, "Insufficient balance");

        IERC20(token).safeTransfer(msg.sender, withdrawAmount);
        emit ProfitWithdrawn(token, withdrawAmount, msg.sender);
    }

    function withdrawNative() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No native balance");

        (bool success, ) = msg.sender.call{value: balance}("");
        require(success, "Transfer failed");
        emit ProfitWithdrawn(address(0), balance, msg.sender);
    }

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
