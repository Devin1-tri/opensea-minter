// Built-in chain definitions for the bot. Each chain has a default public RPC,
// chain id, native currency info, and a block explorer URL. Users can override
// the RPC at runtime or add a fully custom chain (manually or via Chainlist).

export const BUILTIN_CHAINS = {
  ethereum: {
    key: 'ethereum',
    name: 'Ethereum Mainnet',
    chainId: 1,
    rpcUrl: 'https://eth.llamarpc.com',
    explorer: 'https://etherscan.io',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcEnv: 'ETHEREUM_RPC_URL',
  },
  base: {
    key: 'base',
    name: 'Base',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcEnv: 'BASE_RPC_URL',
  },
  arbitrum: {
    key: 'arbitrum',
    name: 'Arbitrum One',
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorer: 'https://arbiscan.io',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcEnv: 'ARBITRUM_RPC_URL',
  },
  optimism: {
    key: 'optimism',
    name: 'Optimism',
    chainId: 10,
    rpcUrl: 'https://mainnet.optimism.io',
    explorer: 'https://optimistic.etherscan.io',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcEnv: 'OPTIMISM_RPC_URL',
  },
};

export const BUILTIN_CHAIN_KEYS = Object.keys(BUILTIN_CHAINS);

// Map an OpenSea URL chain slug to one of our built-in chains (best-effort).
// OpenSea uses slugs like "ethereum", "base", "arbitrum", "optimism", "matic", etc.
export const OPENSEA_CHAIN_SLUG_MAP = {
  ethereum: 'ethereum',
  eth: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  arbitrum_nova: 'arbitrum',
  optimism: 'optimism',
};
