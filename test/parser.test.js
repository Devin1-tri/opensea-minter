// Unit tests for the pure helpers — no network or wallet required.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseOpenseaInput } from '../src/opensea.js';
import { parsePriceOverride } from '../src/minter.js';
import { BUILTIN_CHAINS, BUILTIN_CHAIN_KEYS } from '../src/chains.js';

test('parseOpenseaInput accepts a raw checksummed address', () => {
  const r = parseOpenseaInput('0x1A92f7381B9F03921564a437210bB9396471050C');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'address');
  assert.equal(r.contractAddress, '0x1A92f7381B9F03921564a437210bB9396471050C');
});

test('parseOpenseaInput parses /assets/<chain>/<contract>/<id> URLs', () => {
  const r = parseOpenseaInput(
    'https://opensea.io/assets/base/0x1A92f7381B9F03921564a437210bB9396471050C/42',
  );
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'asset');
  assert.equal(r.contractAddress, '0x1A92f7381B9F03921564a437210bB9396471050C');
  assert.equal(r.tokenId, '42');
  assert.equal(r.chainHint, 'base');
});

test('parseOpenseaInput parses /collection/<slug> URLs', () => {
  const r = parseOpenseaInput('https://opensea.io/collection/some-cool-collection');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'collection');
  assert.equal(r.slug, 'some-cool-collection');
});

test('parseOpenseaInput rejects non-opensea URLs', () => {
  const r = parseOpenseaInput('https://example.com/foo');
  assert.equal(r.ok, false);
});

test('parseOpenseaInput rejects garbage', () => {
  const r = parseOpenseaInput('not a url and not an address');
  assert.equal(r.ok, false);
});

test('parsePriceOverride returns null for blank input', () => {
  assert.equal(parsePriceOverride(''), null);
  assert.equal(parsePriceOverride('   '), null);
});

test('parsePriceOverride converts ether to wei', () => {
  assert.equal(parsePriceOverride('0.01'), 10_000_000_000_000_000n);
});

test('parsePriceOverride throws on bad input', () => {
  assert.throws(() => parsePriceOverride('not-a-number'));
});

test('built-in chains have the required fields', () => {
  for (const key of BUILTIN_CHAIN_KEYS) {
    const c = BUILTIN_CHAINS[key];
    assert.equal(typeof c.name, 'string');
    assert.equal(typeof c.chainId, 'number');
    assert.match(c.rpcUrl, /^https?:\/\//);
    assert.equal(typeof c.currency.symbol, 'string');
  }
});
