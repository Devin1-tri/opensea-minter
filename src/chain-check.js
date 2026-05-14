// Pure helper to detect when an OpenSea-resolved collection lives on a
// different chain than the user picked. Returns a human-readable error
// message when there is a mismatch, or null when chains match (or we can't
// tell). The caller is responsible for terminating the process.

import { BUILTIN_CHAINS, openseaApiChainSlug } from './chains.js';

export function describeChainMismatch(slug, resolved, chain) {
  if (!resolved) return null;
  const collectionChainId = BUILTIN_CHAINS[resolved.chainHint]?.chainId;
  const collectionChainName =
    BUILTIN_CHAINS[resolved.chainHint]?.name ||
    (resolved.openseaChain ? `chain "${resolved.openseaChain}"` : null);

  if (!collectionChainName) return null; // unknown chain — let on-chain checks catch it

  if (collectionChainId && collectionChainId === chain.chainId) return null;
  // For non-built-in target chains, compare via the OpenSea slug:
  // ("matic" === openseaApiChainSlug(137)) etc.
  if (!collectionChainId && resolved.openseaChain === openseaApiChainSlug(chain.chainId)) {
    return null;
  }

  return (
    `Collection "${slug}" lives on ${collectionChainName}, but you selected ` +
    `${chain.name} (chainId ${chain.chainId}). Re-run and pick the matching ` +
    `chain from the chain picker.`
  );
}
