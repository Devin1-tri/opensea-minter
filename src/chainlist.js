// Tiny Chainlist (https://chainlist.org) client used to let users search for any
// EVM chain by name and pick one of its public RPCs. The full Chainlist dataset
// lives at https://chainid.network/chains.json and is cached on disk so we only
// fetch it once per day.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CHAINLIST_URL = 'https://chainid.network/chains.json';
const CACHE_FILE = path.join(os.homedir(), '.cache', 'opensea-minter', 'chainlist.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function readCache() {
  try {
    const stat = await fs.stat(CACHE_FILE);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

async function writeCache(data) {
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(data), 'utf8');
  } catch {
    // Caching is best-effort; ignore failures (e.g. read-only fs).
  }
}

let inMemoryChains = null;

export async function loadChainlist({ forceRefresh = false } = {}) {
  if (inMemoryChains && !forceRefresh) return inMemoryChains;
  if (!forceRefresh) {
    const cached = await readCache();
    if (cached) {
      inMemoryChains = cached;
      return cached;
    }
  }
  const res = await fetch(CHAINLIST_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Failed to fetch Chainlist (${res.status} ${res.statusText})`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Unexpected Chainlist response shape');
  inMemoryChains = data;
  await writeCache(data);
  return data;
}

function isUsableRpc(url) {
  if (typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  // Skip RPCs that require interpolated env keys (e.g. ${INFURA_API_KEY}).
  if (url.includes('${')) return false;
  if (url.includes('YOUR-API-KEY') || url.includes('your-api-key')) return false;
  return true;
}

function normaliseRpcEntry(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof entry.url === 'string') return entry.url;
  return null;
}

export function getPublicRpcs(chain) {
  if (!chain || !Array.isArray(chain.rpc)) return [];
  return chain.rpc
    .map(normaliseRpcEntry)
    .filter((u) => u && isUsableRpc(u));
}

export async function searchChains(query, limit = 15) {
  const chains = await loadChainlist();
  const q = query.trim().toLowerCase();
  if (!q) return chains.slice(0, limit);

  const numericId = /^\d+$/.test(q) ? Number(q) : null;
  const scored = [];
  for (const chain of chains) {
    if (!chain || typeof chain.name !== 'string') continue;
    const name = chain.name.toLowerCase();
    const shortName = (chain.shortName || '').toLowerCase();
    let score = 0;
    if (numericId !== null && chain.chainId === numericId) score = 1000;
    else if (name === q) score = 900;
    else if (shortName === q) score = 800;
    else if (name.startsWith(q)) score = 600;
    else if (shortName.startsWith(q)) score = 500;
    else if (name.includes(q)) score = 300;
    else if (shortName.includes(q)) score = 200;
    if (score > 0) scored.push({ chain, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.chain);
}

export function summariseChainForChoice(chain) {
  const rpcs = getPublicRpcs(chain);
  const rpcCount = rpcs.length;
  const explorer = Array.isArray(chain.explorers) && chain.explorers[0]?.url;
  const tail = explorer ? ` — ${explorer}` : '';
  return `${chain.name} (chainId ${chain.chainId}, ${rpcCount} public RPC${rpcCount === 1 ? '' : 's'})${tail}`;
}

export function chainlistEntryToBotChain(chain, rpcUrl) {
  const explorer = Array.isArray(chain.explorers) && chain.explorers[0]?.url;
  return {
    key: `chainlist-${chain.chainId}`,
    name: chain.name,
    chainId: chain.chainId,
    rpcUrl,
    explorer: explorer || '',
    currency: chain.nativeCurrency
      ? {
          name: chain.nativeCurrency.name || chain.nativeCurrency.symbol || 'Native',
          symbol: chain.nativeCurrency.symbol || 'ETH',
          decimals: chain.nativeCurrency.decimals ?? 18,
        }
      : { name: 'Native', symbol: 'ETH', decimals: 18 },
    rpcEnv: null,
    source: 'chainlist',
  };
}
