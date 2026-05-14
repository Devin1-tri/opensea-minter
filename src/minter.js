// Generic NFT minter. The bot tries a list of common mint function signatures
// against the target contract and uses the first one that successfully
// estimates gas. Mint price is read from common public getters (price /
// mintPrice / cost / MINT_PRICE) when the function is payable. Users can also
// override price and quantity interactively.

import { Contract, formatEther, parseEther } from 'ethers';
import { feesToTxOverrides } from './gas.js';

// Candidate mint signatures, ordered roughly from most-specific to most-generic.
// Each entry maps a human-readable signature to the args it expects given
// (quantity, recipient). Functions returning `undefined` are skipped.
export const MINT_CANDIDATES = [
  {
    sig: 'function mint(uint256 quantity) payable',
    buildArgs: ({ quantity }) => [quantity],
  },
  {
    sig: 'function mint(address to, uint256 quantity) payable',
    buildArgs: ({ quantity, recipient }) => [recipient, quantity],
  },
  {
    sig: 'function publicMint(uint256 quantity) payable',
    buildArgs: ({ quantity }) => [quantity],
  },
  {
    sig: 'function mintPublic(uint256 quantity) payable',
    buildArgs: ({ quantity }) => [quantity],
  },
  {
    sig: 'function claim(uint256 quantity) payable',
    buildArgs: ({ quantity }) => [quantity],
  },
  {
    sig: 'function purchase(uint256 quantity) payable',
    buildArgs: ({ quantity }) => [quantity],
  },
  {
    sig: 'function mint() payable',
    buildArgs: () => [],
  },
];

// Common read-only getters that expose the per-unit mint price (in wei).
const PRICE_GETTERS = [
  'function price() view returns (uint256)',
  'function mintPrice() view returns (uint256)',
  'function MINT_PRICE() view returns (uint256)',
  'function cost() view returns (uint256)',
  'function PRICE() view returns (uint256)',
  'function publicPrice() view returns (uint256)',
];

export async function detectMintPriceWei(provider, address) {
  for (const sig of PRICE_GETTERS) {
    try {
      const c = new Contract(address, [sig], provider);
      const fnName = sig.match(/function (\w+)/)[1];
      const value = await c[fnName]();
      if (typeof value === 'bigint' && value >= 0n) {
        return { priceWei: value, source: fnName };
      }
    } catch {
      // try next
    }
  }
  return { priceWei: null, source: null };
}

// Try each mint candidate in order. Returns the first one whose `estimateGas`
// succeeds for the given (quantity, value) overrides. Throws if none work.
export async function findWorkingMint({ wallet, address, quantity, valueWei }) {
  const errors = [];
  for (const candidate of MINT_CANDIDATES) {
    const contract = new Contract(address, [candidate.sig], wallet);
    const fnName = candidate.sig.match(/function (\w+)/)[1];
    const args = candidate.buildArgs({ quantity, recipient: wallet.address });
    try {
      const gasLimit = await contract[fnName].estimateGas(...args, { value: valueWei });
      return { contract, fnName, args, gasLimit, signature: candidate.sig };
    } catch (err) {
      errors.push({ sig: candidate.sig, message: err.shortMessage || err.message });
    }
  }
  const detail = errors.map((e) => `  - ${e.sig}: ${e.message}`).join('\n');
  const error = new Error(
    `Could not find a working mint function on this contract. Tried:\n${detail}`,
  );
  error.attempts = errors;
  throw error;
}

export async function sendMint({ wallet, address, quantity, priceWei, fees }) {
  const valueWei = priceWei * BigInt(quantity);
  const { contract, fnName, args, gasLimit, signature } = await findWorkingMint({
    wallet,
    address,
    quantity,
    valueWei,
  });
  const overrides = {
    value: valueWei,
    gasLimit: (gasLimit * 12n) / 10n, // +20% headroom on gas limit
    ...feesToTxOverrides(fees),
  };
  const tx = await contract[fnName](...args, overrides);
  return { tx, signature, valueWei, gasLimit, fnName };
}

export function explainCostBreakdown({ quantity, priceWei, fees, gasLimit, currencySymbol }) {
  const totalValue = priceWei * BigInt(quantity);
  const maxGasCost =
    fees.mode === 'eip1559'
      ? fees.maxFeePerGas * gasLimit
      : fees.gasPrice * gasLimit;
  const totalUpperBound = totalValue + maxGasCost;
  return {
    mintValue: `${formatEther(totalValue)} ${currencySymbol}`,
    maxGasCost: `${formatEther(maxGasCost)} ${currencySymbol}`,
    maxTotal: `${formatEther(totalUpperBound)} ${currencySymbol}`,
  };
}

export function parsePriceOverride(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return null;
  try {
    return parseEther(trimmed);
  } catch {
    throw new Error(`Could not parse "${trimmed}" as an ether amount.`);
  }
}
