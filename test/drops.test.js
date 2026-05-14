// Unit tests for the OpenSea Drops API client helpers. We don't hit the real
// API here — instead we stub global.fetch to return canned responses and
// assert that our wrappers parse them into the expected shape.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchDrop,
  buildDropMintTransaction,
  fetchContractCollection,
  describeStage,
} from '../src/drops.js';

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

test('fetchDrop normalises stages into the bot shape', async () => {
  const restore = mockFetch(async (url, options) => {
    assert.match(String(url), /\/api\/v2\/drops\/my-drop$/);
    assert.equal(options.headers['x-api-key'], 'test-key');
    return jsonResponse({
      collection_slug: 'my-drop',
      name: 'My Drop',
      total_supply: '1000',
      total_minted: '42',
      stages: [
        {
          uuid: 's1',
          stage_type: 'presale',
          label: 'Allowlist',
          price: '5000000000000000',
          price_currency_address: '0x0000000000000000000000000000000000000000',
          start_time: '2030-01-01T00:00:00Z',
          end_time: '2030-01-02T00:00:00Z',
          max_per_wallet: '2',
        },
        {
          uuid: 's2',
          stage_type: 'public_sale',
          label: 'Public',
          price: '10000000000000000',
          price_currency_address: '0x0000000000000000000000000000000000000000',
          start_time: '2020-01-01T00:00:00Z',
          end_time: '2030-01-03T00:00:00Z',
          max_per_wallet: '5',
        },
      ],
    });
  });

  try {
    const drop = await fetchDrop('my-drop', 'test-key');
    assert.equal(drop.slug, 'my-drop');
    assert.equal(drop.name, 'My Drop');
    assert.equal(drop.totalSupply, 1000n);
    assert.equal(drop.totalMinted, 42n);
    assert.equal(drop.stages.length, 2);

    const allowlist = drop.stages[0];
    assert.equal(allowlist.label, 'Allowlist');
    assert.equal(allowlist.type, 'presale');
    assert.equal(allowlist.priceWei, 5_000_000_000_000_000n);
    assert.equal(allowlist.maxPerWallet, 2n);
    assert.equal(allowlist.status, 'upcoming');

    const publicStage = drop.stages[1];
    assert.equal(publicStage.status, 'active');
  } finally {
    restore();
  }
});

test('buildDropMintTransaction returns target / data / value as bigint', async () => {
  const restore = mockFetch(async (url, options) => {
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.minter, '0xabc');
    assert.equal(body.quantity, 3);
    return jsonResponse({
      to: '0x1111111111111111111111111111111111111111',
      data: '0xdeadbeef',
      value: '0x16345785d8a0000', // 0.1 ETH in wei
      chain: 'base',
    });
  });

  try {
    const tx = await buildDropMintTransaction({
      slug: 'cool-drop',
      minter: '0xabc',
      quantity: 3,
      apiKey: 'test-key',
    });
    assert.equal(tx.to, '0x1111111111111111111111111111111111111111');
    assert.equal(tx.data, '0xdeadbeef');
    assert.equal(tx.value, 100_000_000_000_000_000n);
    assert.equal(tx.chain, 'base');
  } finally {
    restore();
  }
});

test('buildDropMintTransaction surfaces 422 errors with a useful message', async () => {
  const restore = mockFetch(async () =>
    jsonResponse({ errors: ['wallet not in allowlist'] }, { status: 422, statusText: 'Unprocessable Entity' }),
  );
  try {
    await assert.rejects(
      buildDropMintTransaction({
        slug: 'cool-drop',
        minter: '0xabc',
        quantity: 1,
        apiKey: 'test-key',
      }),
      (err) => {
        assert.equal(err.status, 422);
        assert.match(err.message, /wallet not in allowlist/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('fetchContractCollection extracts collection slug', async () => {
  const restore = mockFetch(async (url) => {
    assert.match(String(url), /\/api\/v2\/chain\/base\/contract\/0xabc$/);
    return jsonResponse({
      address: '0xabc',
      chain: 'base',
      collection: 'cool-collection',
    });
  });
  try {
    const result = await fetchContractCollection('base', '0xabc', 'test-key');
    assert.equal(result.collectionSlug, 'cool-collection');
    assert.equal(result.chain, 'base');
  } finally {
    restore();
  }
});

test('describeStage produces a human-readable summary', () => {
  const stage = {
    label: 'Public',
    type: 'public_sale',
    priceWei: 10_000_000_000_000_000n,
    startTime: Date.parse('2020-01-01T00:00:00Z'),
    endTime: Date.parse('2030-01-01T00:00:00Z'),
    maxPerWallet: 5n,
    status: 'active',
  };
  const out = describeStage(stage, 'ETH');
  assert.match(out, /Public/);
  assert.match(out, /0\.01 ETH/);
  assert.match(out, /cap 5\/wallet/);
  assert.match(out, /ACTIVE/);
});

test('describeStage marks free mints', () => {
  const stage = {
    label: 'Free',
    type: 'public_sale',
    priceWei: 0n,
    startTime: null,
    endTime: null,
    maxPerWallet: null,
    status: 'active',
  };
  const out = describeStage(stage, 'ETH');
  assert.match(out, /free/);
  assert.match(out, /no cap/);
});

test('fetchDrop throws MISSING_API_KEY without a key', async () => {
  await assert.rejects(fetchDrop('some-slug', null), (err) => {
    assert.equal(err.code, 'MISSING_API_KEY');
    return true;
  });
});
