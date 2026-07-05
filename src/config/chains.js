/**
 * Multi-chain configuration for Flash Liquidator
 *
 * Supported chains: Polygon, Arbitrum, Base, BSC, Avalanche
 * Focus on chains with less competition and lower gas costs
 */

const CHAINS = {
  POLYGON: {
    name: 'Polygon',
    chainId: 137,
    nativeToken: 'POL',
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC

    // RPC endpoints (use env var or fallback)
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    // WebSocket for real-time events (CRITICAL for competitive liquidations!)
    wssUrl: process.env.POLYGON_WSS_URL || null,

    // Block explorer
    explorer: 'https://polygonscan.com',

    // Gas settings (Polygon is cheap!)
    gasPrice: '50', // gwei
    maxGasPrice: '500', // gwei

    // Aave V3 - Flash loan source
    aaveV3: {
      pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      poolDataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
      oracle: '0xb023e699F5a33916Ea823A16485e259257cA8Bd1',
    },

    // DEX routers for swapping collateral
    dexes: {
      quickswap: {
        router: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
        name: 'QuickSwap',
      },
      sushiswap: {
        router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
        name: 'SushiSwap',
      },
      uniswapV3: {
        router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        name: 'Uniswap V3',
      },
    },

    // Default swap router
    defaultRouter: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',

    // Common tokens
    tokens: {
      USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Native USDC
      USDC_E: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // Bridged USDC.e
      USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
      WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
      WBTC: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
      LINK: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39',
      AAVE: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B',
    },
  },

  ARBITRUM: {
    name: 'Arbitrum',
    chainId: 42161,
    nativeToken: 'ETH',
    wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH

    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    wssUrl: process.env.ARBITRUM_WSS_URL || null,
    explorer: 'https://arbiscan.io',

    gasPrice: '0.1', // gwei (Arbitrum is very cheap)
    maxGasPrice: '1',

    aaveV3: {
      pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      poolDataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
      oracle: '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7',
    },

    // Radiant Capital - Less competition, 15% liquidation bonus!
    radiant: {
      pool: '0xF4B1486DD74D07706052A33d31d7c0AAFD0659E1',
      oracle: '0x0aDDd25a91563696D8567Df78D5A01C9a991F9B8',
      liquidationBonus: 1500, // 15%!
    },

    // GMX - Leveraged perps, different liquidation mechanism
    gmx: {
      vault: '0x489ee077994B6658eAfA855C308275EAd8097C4A',
      positionRouter: '0xb87a436B93fFE9D75c5cFA7bAcFff96430b09868',
    },

    dexes: {
      uniswapV3: {
        router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        name: 'Uniswap V3',
      },
      sushiswap: {
        router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
        name: 'SushiSwap',
      },
      camelot: {
        router: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
        name: 'Camelot',
      },
    },

    defaultRouter: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',

    tokens: {
      USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Native USDC
      USDC_E: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // Bridged USDC.e
      USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
      WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
      LINK: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
      ARB: '0x912CE59144191C1204E64559FE8253a0e49E6548',
      RDNT: '0x3082CC23568eA640225c2467653dB90e9250AaA0', // Radiant token
    },
  },

  BASE: {
    name: 'Base',
    chainId: 8453,
    nativeToken: 'ETH',
    wrappedNative: '0x4200000000000000000000000000000000000006', // WETH

    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    wssUrl: process.env.BASE_WSS_URL || null,
    explorer: 'https://basescan.org',

    gasPrice: '0.01', // gwei (Base is very cheap!)
    maxGasPrice: '0.5',

    aaveV3: {
      pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
      poolDataProvider: '0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac',
      oracle: '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156',
    },

    // Moonwell - Compound fork on Base, less competition!
    moonwell: {
      comptroller: '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C',
      oracle: '0xEC942bE8A8114bFD0396A5052c36027f2cA6a9d0',
      mWETH: '0x628ff693426583D9a7FB391E54366292F509D457',
      mUSDbC: '0x703843C3379b52F9FF486c9f5892218d2a065cC8',
      mDAI: '0x73b06D8d18De422E269645eaCe15400DE7462417',
      liquidationBonus: 800, // 8%
    },

    // Seamless Protocol - Native Base lending
    seamless: {
      pool: '0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7',
      poolDataProvider: '0x2A0979257105834789bC6b9E1B00446DFbA8dFBa',
      liquidationBonus: 500, // 5%
    },

    // Compound V3 on Base
    compoundV3: {
      comet: '0xb125E6687d4313864e53df431d5425969c15Eb2F', // USDC market
    },

    dexes: {
      uniswapV3: {
        router: '0x2626664c2603336E57B271c5C0b26F421741e481',
        name: 'Uniswap V3',
      },
      aerodrome: {
        router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
        name: 'Aerodrome',
      },
      baseswap: {
        router: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
        name: 'BaseSwap',
      },
    },

    defaultRouter: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',

    tokens: {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Native USDC
      USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', // Bridged USDC
      DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
      WETH: '0x4200000000000000000000000000000000000006',
      cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', // Coinbase ETH
    },
  },

  BSC: {
    name: 'BNB Chain',
    chainId: 56,
    nativeToken: 'BNB',
    wrappedNative: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB

    rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
    wssUrl: process.env.BSC_WSS_URL || null,
    explorer: 'https://bscscan.com',

    gasPrice: '3', // gwei
    maxGasPrice: '10',

    // BSC uses Venus (no Aave V3)
    // We'll use PancakeSwap flash swaps instead
    aaveV3: null, // Not available on BSC

    // Venus Protocol
    venus: {
      comptroller: '0xfD36E2c2a6789Db23113685031d7F16329158384',
      oracle: '0xd8B6dA2bfEC71D684D3E2a2FC9492dDad5C3787F',
      vBNB: '0xA07c5b74C9B40447a954e1466938b865b6BBea36',
      vUSDT: '0xfD5840Cd36d94D7229439859C0112a4185BC0255',
      vUSDC: '0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8',
      vBUSD: '0x95c78222B3D6e262426483D42CfA53685A67Ab9D',
    },

    dexes: {
      pancakeswap: {
        router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
        name: 'PancakeSwap',
      },
      biswap: {
        router: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8',
        name: 'BiSwap',
      },
    },

    defaultRouter: '0x10ED43C718714eb63d5aA57B78B54704E256024E',

    tokens: {
      USDT: '0x55d398326f99059fF775485246999027B3197955',
      USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
      DAI: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
      ETH: '0x2170Ed0807473E735DF4e4F5D8d72C3e3db1f42c',
      BTCB: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
    },
  },

  AVALANCHE: {
    name: 'Avalanche',
    chainId: 43114,
    nativeToken: 'AVAX',
    wrappedNative: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX

    rpcUrl: process.env.AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc',
    wssUrl: process.env.AVALANCHE_WSS_URL || null,
    explorer: 'https://snowtrace.io',

    gasPrice: '25', // gwei
    maxGasPrice: '100',

    aaveV3: {
      pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      poolDataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
      oracle: '0xEBd36016B3eD09D4693Ed4251c67Bd858c3c7C9C',
    },

    // Benqi - Compound fork on Avalanche (less competition!)
    benqi: {
      comptroller: '0x486Af39519B4Dc9a7fCcd318217352830E8AD9b4',
      oracle: '0x316aE55Ec59e0bB817d592c20c40f3a9B4a1Fe93',
      qiAVAX: '0x5C0401e81Bc07Ca70fAD469b451682c0d747Ef1c',
      qiUSDC: '0xBEb5d47A3f720Ec0a390d04b4d41ED7d9688bC7F',
      qiUSDT: '0xc9e5999b8e75C3fEB117F6f73E664b9f3C8ca65C',
    },

    dexes: {
      traderjoe: {
        router: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4',
        name: 'Trader Joe',
      },
      pangolin: {
        router: '0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106',
        name: 'Pangolin',
      },
    },

    defaultRouter: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4',

    tokens: {
      USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // Native USDC
      USDC_E: '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664', // Bridged USDC.e
      USDT: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
      DAI_E: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70',
      WETH_E: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
      WBTC_E: '0x50b7545627a5162F82A992c33b87aDc75187B218',
    },
  },
};

/**
 * Get chain configuration
 */
function getChain(chainName) {
  const chain = CHAINS[chainName?.toUpperCase()];
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainName}. Supported: ${Object.keys(CHAINS).join(', ')}`);
  }
  return chain;
}

/**
 * Get all supported chain names
 */
function getSupportedChains() {
  return Object.keys(CHAINS);
}

module.exports = {
  CHAINS,
  getChain,
  getSupportedChains,
};

