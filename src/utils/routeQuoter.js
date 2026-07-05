/**
 * Route Quoter
 *
 * Quotes a collateral -> debt token swap across all available DEXes
 * (UniswapV2-style routers + Uniswap V3 via QuoterV2) and returns the best
 * route in the exact shape FlashLiquidatorV2.LiquidationParams expects:
 * { swapMode, swapRouter, swapPath, minOutRate }.
 *
 * minOutRate = min out per 1e18 in, so the on-chain slippage floor scales
 * with the collateral amount actually seized.
 */

const { ethers } = require('ethers');

const QUOTER_V2_ABI = [
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
];
const V2_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
];

// Uniswap V3 QuoterV2 per chainId (SwapRouter comes from chain config)
const UNIV3_QUOTER = {
  137: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', // Polygon
  42161: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', // Arbitrum
  8453: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', // Base
};

// Intermediate hop tokens per chainId (wrapped native is added automatically)
const HOP_TOKENS = {
  137: ['0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'], // USDC, USDC.e
  42161: ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831'], // USDC
  8453: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'], // USDC
};

const V3_FEE_TIERS = [100, 500, 3000, 10000];

class RouteQuoter {
  constructor(chainConfig, provider) {
    this.chain = chainConfig;
    this.provider = provider;

    this.v2Routers = Object.values(chainConfig.dexes || {})
      .filter((d) => d.router && !/v3/i.test(d.name || ''))
      .map((d) => ({ name: d.name, address: d.router }));

    this.v3Router = (chainConfig.dexes?.uniswapV3 || {}).router || null;
    this.v3Quoter = UNIV3_QUOTER[chainConfig.chainId] || null;
    this.hops = [chainConfig.wrappedNative, ...(HOP_TOKENS[chainConfig.chainId] || [])];
  }

  /**
   * Find the best route for swapping amountIn of tokenIn into tokenOut.
   * @returns {{swapMode:number, swapRouter:string, swapPath:string, minOutRate:bigint, amountOut:bigint, label:string}|null}
   */
  async quoteBestRoute(tokenIn, tokenOut, amountIn, slippagePercent = 1) {
    if (!amountIn || amountIn <= 0n) return null;
    tokenIn = ethers.getAddress(tokenIn);
    tokenOut = ethers.getAddress(tokenOut);
    if (tokenIn === tokenOut) return null;

    const attempts = [];

    // ---- V2-style candidates: direct + one-hop paths ----
    for (const r of this.v2Routers) {
      const router = new ethers.Contract(r.address, V2_ROUTER_ABI, this.provider);
      const paths = [[tokenIn, tokenOut]];
      for (const hop of this.hops) {
        const h = ethers.getAddress(hop);
        if (h !== tokenIn && h !== tokenOut) paths.push([tokenIn, h, tokenOut]);
      }
      for (const path of paths) {
        attempts.push(
          router.getAmountsOut(amountIn, path).then((amounts) => ({
            swapMode: 0,
            swapRouter: r.address,
            swapPath: ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [path]),
            amountOut: amounts[amounts.length - 1],
            label: `${r.name}:${path.length === 2 ? 'direct' : 'via-hop'}`,
          }))
        );
      }
    }

    // ---- Uniswap V3 candidates: direct fee tiers + two-hop via hop tokens ----
    if (this.v3Router && this.v3Quoter) {
      const quoter = new ethers.Contract(this.v3Quoter, QUOTER_V2_ABI, this.provider);
      const v3Paths = [];
      for (const fee of V3_FEE_TIERS) {
        v3Paths.push({
          label: `UniV3:direct-${fee}`,
          path: ethers.solidityPacked(['address', 'uint24', 'address'], [tokenIn, fee, tokenOut]),
        });
      }
      for (const hop of this.hops) {
        const h = ethers.getAddress(hop);
        if (h === tokenIn || h === tokenOut) continue;
        for (const [feeA, feeB] of [[500, 500], [3000, 500], [500, 3000], [500, 100]]) {
          v3Paths.push({
            label: `UniV3:via-hop-${feeA}/${feeB}`,
            path: ethers.solidityPacked(
              ['address', 'uint24', 'address', 'uint24', 'address'],
              [tokenIn, feeA, h, feeB, tokenOut]
            ),
          });
        }
      }
      for (const c of v3Paths) {
        attempts.push(
          quoter.quoteExactInput.staticCall(c.path, amountIn).then((res) => ({
            swapMode: 1,
            swapRouter: this.v3Router,
            swapPath: c.path,
            amountOut: res[0],
            label: c.label,
          }))
        );
      }
    }

    const results = (await Promise.allSettled(attempts))
      .filter((r) => r.status === 'fulfilled' && r.value.amountOut > 0n)
      .map((r) => r.value);

    if (results.length === 0) return null;

    let best = results[0];
    for (const r of results) if (r.amountOut > best.amountOut) best = r;

    // Rate floor: out per 1e18 in, minus slippage
    const slipBps = BigInt(Math.round(slippagePercent * 100));
    best.minOutRate = (best.amountOut * (10000n - slipBps) * 10n ** 18n) / (10000n * amountIn);

    return best;
  }
}

module.exports = RouteQuoter;
