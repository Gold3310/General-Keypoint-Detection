'use strict';

/**
 * Well-known EVM chains with free public RPC endpoints (no API key needed).
 * You can always override the RPC with --rpc <url> or RPC_URL in .env.
 * Add your own chains to this table if you need others.
 */
const CHAINS = {
  ethereum: {
    chainId: 1, name: 'Ethereum', symbol: 'ETH', testnet: false,
    rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io',
  },
  sepolia: {
    chainId: 11155111, name: 'Ethereum Sepolia (testnet)', symbol: 'ETH', testnet: true,
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io',
  },
  bsc: {
    chainId: 56, name: 'BNB Smart Chain', symbol: 'BNB', testnet: false,
    rpc: 'https://bsc-rpc.publicnode.com', explorer: 'https://bscscan.com',
  },
  'bsc-testnet': {
    chainId: 97, name: 'BNB Smart Chain Testnet', symbol: 'tBNB', testnet: true,
    rpc: 'https://bsc-testnet-rpc.publicnode.com', explorer: 'https://testnet.bscscan.com',
  },
  polygon: {
    chainId: 137, name: 'Polygon PoS', symbol: 'POL', testnet: false,
    rpc: 'https://polygon-bor-rpc.publicnode.com', explorer: 'https://polygonscan.com',
  },
  'polygon-amoy': {
    chainId: 80002, name: 'Polygon Amoy (testnet)', symbol: 'POL', testnet: true,
    rpc: 'https://polygon-amoy-bor-rpc.publicnode.com', explorer: 'https://amoy.polygonscan.com',
  },
  arbitrum: {
    chainId: 42161, name: 'Arbitrum One', symbol: 'ETH', testnet: false,
    rpc: 'https://arbitrum-one-rpc.publicnode.com', explorer: 'https://arbiscan.io',
  },
  'arbitrum-sepolia': {
    chainId: 421614, name: 'Arbitrum Sepolia (testnet)', symbol: 'ETH', testnet: true,
    rpc: 'https://arbitrum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.arbiscan.io',
  },
  base: {
    chainId: 8453, name: 'Base', symbol: 'ETH', testnet: false,
    rpc: 'https://base-rpc.publicnode.com', explorer: 'https://basescan.org',
  },
  'base-sepolia': {
    chainId: 84532, name: 'Base Sepolia (testnet)', symbol: 'ETH', testnet: true,
    rpc: 'https://base-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.basescan.org',
  },
  optimism: {
    chainId: 10, name: 'OP Mainnet', symbol: 'ETH', testnet: false,
    rpc: 'https://optimism-rpc.publicnode.com', explorer: 'https://optimistic.etherscan.io',
  },
  'optimism-sepolia': {
    chainId: 11155420, name: 'OP Sepolia (testnet)', symbol: 'ETH', testnet: true,
    rpc: 'https://optimism-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.optimistic.etherscan.io',
  },
};

/**
 * Resolve a chain by preset name ("bsc"), numeric id ("56"), or hex id ("0x38").
 * Unknown numeric ids are allowed but need an explicit RPC via --rpc / RPC_URL.
 */
function resolveChain(spec) {
  if (spec == null || spec === '') return null;
  const key = String(spec).trim().toLowerCase().replace(/_/g, '-');
  if (CHAINS[key]) return CHAINS[key];
  if (/^(0x)?[0-9]+$/.test(key)) {
    const id = key.startsWith('0x') ? parseInt(key, 16) : parseInt(key, 10);
    for (const preset of Object.values(CHAINS)) {
      if (preset.chainId === id) return preset;
    }
    return { chainId: id, name: `chain ${id}`, symbol: 'native', testnet: false, rpc: null, explorer: null };
  }
  const known = Object.keys(CHAINS).join(', ');
  throw new Error(`Unknown chain "${spec}". Known: ${known} — or pass a chain id + --rpc <url>.`);
}

module.exports = { CHAINS, resolveChain };
