// Tests for the chain-mismatch helper and the resolveCollectionSlug enrichment.
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeChainMismatch } from '../src/chain-check.js';
import { resolveCollectionSlug } from '../src/opensea.js';
import { BUILTIN_CHAINS } from '../src/chains.js';

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = original;
  };
}

function jsonResponse(body, init = { status: 200 }) {
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    statusText: init.statusText || '',
    json: async () => body,
  };
}

test('describeChainMismatch returns null when chains match', () => {
  const result = describeChainMismatch(
    'cool-drop',
    { chainHint: 'base', openseaChain: 'base' },
    BUILTIN_CHAINS.base,
  );
  assert.equal(result, null);
});

test('describeChainMismatch flags a Base collection vs Ethereum target', () => {
  const result = describeChainMismatch(
    'thenemesisnft',
    { chainHint: 'base', openseaChain: 'base' },
    BUILTIN_CHAINS.ethereum,
  );
  assert.match(result, /thenemesisnft/);
  assert.match(result, /Base/);
  assert.match(result, /Ethereum Mainnet/);
  assert.match(result, /Re-run and pick the matching chain/);
});

test('describeChainMismatch maps OpenSea "matic" chain to built-in Polygon', () => {
  // OpenSea returns chain="matic" for Polygon collections; the bot maps that
  // to its 'polygon' key. Picking Polygon should match, picking anything else
  // should flag a mismatch.
  const resolved = { chainHint: 'polygon', openseaChain: 'matic' };
  assert.equal(describeChainMismatch('p-drop', resolved, BUILTIN_CHAINS.polygon), null);
  const mismatch = describeChainMismatch('p-drop', resolved, BUILTIN_CHAINS.base);
  assert.match(mismatch, /Polygon/);
  assert.match(mismatch, /Base/);
});

test('describeChainMismatch returns null when OpenSea chain is unknown to us', () => {
  // e.g. resolved to Zora but we don't have Zora in BUILTIN_CHAINS — let the
  // on-chain code path surface the real error rather than guessing.
  const result = describeChainMismatch(
    'unknown-chain-drop',
    { chainHint: null, openseaChain: null },
    BUILTIN_CHAINS.ethereum,
  );
  assert.equal(result, null);
});

test('resolveCollectionSlug exposes the raw OpenSea chain', async () => {
  const restore = mockFetch(async (url) => {
    assert.match(String(url), /\/api\/v2\/collections\/thenemesisnft$/);
    return jsonResponse({
      collection: 'thenemesisnft',
      contracts: [{ address: '0x4d285Fa121E4f64dB025CFE903f36CFa361Df33e', chain: 'base' }],
    });
  });
  try {
    const result = await resolveCollectionSlug('thenemesisnft', 'test-key');
    assert.equal(result.contractAddress, '0x4d285Fa121E4f64dB025CFE903f36CFa361Df33e');
    assert.equal(result.chainHint, 'base');
    assert.equal(result.openseaChain, 'base');
  } finally {
    restore();
  }
});

test('resolveCollectionSlug normalises unknown chains to a null hint but keeps openseaChain', async () => {
  const restore = mockFetch(async () =>
    jsonResponse({
      collection: 'zora-drop',
      contracts: [{ address: '0x4d285Fa121E4f64dB025CFE903f36CFa361Df33e', chain: 'zora' }],
    }),
  );
  try {
    const result = await resolveCollectionSlug('zora-drop', 'test-key');
    assert.equal(result.chainHint, null);
    assert.equal(result.openseaChain, 'zora');
  } finally {
    restore();
  }
});
