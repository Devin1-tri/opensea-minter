// Parse user input (either an OpenSea URL or a raw contract address) into a
// canonical { contractAddress, tokenId?, chainHint? } shape. Optionally falls
// back to the OpenSea API for collection-slug URLs when OPENSEA_API_KEY is set.

import { isAddress, getAddress } from 'ethers';
import { OPENSEA_CHAIN_SLUG_MAP } from './chains.js';

const OPENSEA_HOSTS = new Set(['opensea.io', 'www.opensea.io', 'pro.opensea.io']);

export function parseOpenseaInput(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) {
    return { ok: false, error: 'Empty input.' };
  }

  // Plain contract address.
  if (isAddress(input)) {
    return {
      ok: true,
      kind: 'address',
      contractAddress: getAddress(input),
      tokenId: null,
      chainHint: null,
      slug: null,
    };
  }

  // Try to parse as URL.
  let url;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: 'Not a valid contract address or OpenSea URL.' };
  }

  if (!OPENSEA_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      error: `Unsupported host "${url.hostname}". Provide an opensea.io URL or a contract address.`,
    };
  }

  const segments = url.pathname.split('/').filter(Boolean);

  // /assets/<chain>/<contract>/<tokenId>
  if (segments[0] === 'assets' && segments.length >= 4) {
    const [, chainSlug, address, tokenId] = segments;
    if (isAddress(address)) {
      return {
        ok: true,
        kind: 'asset',
        contractAddress: getAddress(address),
        tokenId,
        chainHint: OPENSEA_CHAIN_SLUG_MAP[chainSlug?.toLowerCase()] || null,
        slug: null,
      };
    }
  }

  // /item/<chain>/<contract>/<tokenId> (newer pro.opensea.io style)
  if (segments[0] === 'item' && segments.length >= 4) {
    const [, chainSlug, address, tokenId] = segments;
    if (isAddress(address)) {
      return {
        ok: true,
        kind: 'asset',
        contractAddress: getAddress(address),
        tokenId,
        chainHint: OPENSEA_CHAIN_SLUG_MAP[chainSlug?.toLowerCase()] || null,
        slug: null,
      };
    }
  }

  // /collection/<slug>
  if (segments[0] === 'collection' && segments.length >= 2) {
    return {
      ok: true,
      kind: 'collection',
      contractAddress: null,
      tokenId: null,
      chainHint: null,
      slug: segments[1],
    };
  }

  return {
    ok: false,
    error: 'Unrecognised OpenSea URL format. Paste a /assets/, /item/, or /collection/ URL — or a contract address.',
  };
}

// Resolve an OpenSea collection slug to a (chain, contract) pair using the
// public OpenSea API v2. Requires an API key.
export async function resolveCollectionSlug(slug, apiKey) {
  if (!apiKey) {
    throw new Error(
      'OpenSea collection URLs need an OPENSEA_API_KEY in your .env. ' +
        'Alternatively, paste the contract address directly.',
    );
  }
  const res = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`, {
    headers: { accept: 'application/json', 'x-api-key': apiKey },
  });
  if (!res.ok) {
    throw new Error(`OpenSea API returned ${res.status} for slug "${slug}".`);
  }
  const body = await res.json();
  const primary = Array.isArray(body.contracts) ? body.contracts[0] : null;
  if (!primary || !primary.address) {
    throw new Error(`OpenSea API did not return a primary contract for slug "${slug}".`);
  }
  return {
    contractAddress: getAddress(primary.address),
    chainHint: OPENSEA_CHAIN_SLUG_MAP[(primary.chain || '').toLowerCase()] || null,
  };
}
