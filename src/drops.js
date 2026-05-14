// Client for OpenSea's official Drops API.
// https://docs.opensea.io/reference/get_drop_by_slug
// https://docs.opensea.io/reference/build_drop_mint_transaction
//
// These endpoints let us:
//   - Discover the stages of a drop (Public / Allowlist / Presale / etc.)
//     along with their prices, schedules and per-wallet limits.
//   - Build a ready-to-sign mint transaction for a given (minter, quantity).
//     OpenSea's backend picks the first eligible stage automatically and
//     returns 422 if the wallet is not eligible for any active stage.
//
// All endpoints require an API key (`OPENSEA_API_KEY`).

const API_BASE = 'https://api.opensea.io/api/v2';

function ensureKey(apiKey) {
  if (!apiKey) {
    const err = new Error(
      'OPENSEA_API_KEY is not set. Add it to your .env to use stage/eligibility detection. ' +
        'Get a key at https://docs.opensea.io/reference/api-keys.',
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }
}

async function osFetch(path, { apiKey, method = 'GET', body } = {}) {
  ensureKey(apiKey);
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    // ignore
  }
  if (!res.ok) {
    const apiErrors = Array.isArray(parsed?.errors) ? parsed.errors.join('; ') : '';
    const err = new Error(
      `OpenSea API ${res.status} ${res.statusText} on ${method} ${path}` +
        (apiErrors ? ` — ${apiErrors}` : ''),
    );
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

// GET /api/v2/chain/{chain}/contract/{address} — returns collection metadata
// for a deployed contract on a given OpenSea-supported chain. We use it to
// resolve a contract address (or asset URL) back to its OpenSea collection slug.
export async function fetchContractCollection(chainSlug, address, apiKey) {
  const body = await osFetch(`/chain/${chainSlug}/contract/${address}`, { apiKey });
  return {
    collectionSlug: body?.collection || null,
    contractAddress: body?.address || address,
    chain: body?.chain || chainSlug,
    raw: body,
  };
}

// GET /api/v2/drops/{slug} — returns the full drop config: stages, supply,
// price currency, etc. Stages are normalised into a friendlier shape.
export async function fetchDrop(slug, apiKey) {
  const raw = await osFetch(`/drops/${encodeURIComponent(slug)}`, { apiKey });
  return {
    slug: raw?.collection_slug || slug,
    name: raw?.name || slug,
    totalSupply: parseBigIntString(raw?.total_supply),
    totalMinted: parseBigIntString(raw?.total_minted),
    stages: (raw?.stages || []).map(normaliseStage),
    raw,
  };
}

// POST /api/v2/drops/{slug}/mint — returns { to, data, value, chain } for the
// caller to sign and submit. The backend selects the first eligible stage for
// the minter address. Throws 409 if the drop isn't active, 422 if the wallet
// isn't eligible.
export async function buildDropMintTransaction({ slug, minter, quantity, apiKey }) {
  const body = await osFetch(`/drops/${encodeURIComponent(slug)}/mint`, {
    apiKey,
    method: 'POST',
    body: { minter, quantity },
  });
  return {
    to: body.to,
    data: body.data,
    value: parseWeiField(body.value),
    chain: body.chain,
    raw: body,
  };
}

function parseBigIntString(value) {
  if (value == null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

// The API returns wei as a hex or decimal string depending on the field. The
// schema says hex for the build_mint `value`, decimal for stage `price`.
function parseWeiField(value) {
  if (value == null) return 0n;
  if (typeof value === 'bigint') return value;
  const s = String(value).trim();
  if (s.startsWith('0x') || s.startsWith('0X')) return BigInt(s);
  if (/^\d+$/.test(s)) return BigInt(s);
  // Fallback: try generic BigInt parsing.
  return BigInt(s);
}

function normaliseStage(stage) {
  const startMs = parseIsoToMs(stage?.start_time);
  const endMs = parseIsoToMs(stage?.end_time);
  const now = Date.now();
  const status =
    startMs != null && now < startMs
      ? 'upcoming'
      : endMs != null && now > endMs
        ? 'ended'
        : 'active';
  return {
    uuid: stage?.uuid || null,
    type: stage?.stage_type || 'unknown',
    label: stage?.label || stage?.stage_type || 'Stage',
    priceWei: parseBigIntString(stage?.price) ?? 0n,
    priceCurrency: stage?.price_currency_address || null,
    startTime: startMs,
    endTime: endMs,
    maxPerWallet: parseBigIntString(stage?.max_per_wallet),
    status,
    raw: stage,
  };
}

function parseIsoToMs(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

// Human-readable summary for the stage list shown to the user.
export function describeStage(stage, currencySymbol) {
  const price = stage.priceWei === 0n ? 'free' : `${formatWeiToEther(stage.priceWei)} ${currencySymbol}`;
  const window = describeWindow(stage.startTime, stage.endTime);
  const cap = stage.maxPerWallet != null ? `cap ${stage.maxPerWallet.toString()}/wallet` : 'no cap';
  const status = stage.status.toUpperCase();
  return `${stage.label} (${stage.type}) — ${price}, ${window}, ${cap} · ${status}`;
}

function describeWindow(startMs, endMs) {
  const start = startMs ? new Date(startMs).toISOString().replace('.000Z', 'Z') : '—';
  const end = endMs ? new Date(endMs).toISOString().replace('.000Z', 'Z') : '—';
  return `${start} → ${end}`;
}

function formatWeiToEther(wei) {
  // Match ethers formatEther without importing it here (keeps drops.js
  // dependency-light). Returns up to 18 decimal places, trimmed.
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = abs % 10n ** 18n;
  let fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
  if (fracStr === '') fracStr = '0';
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr}`;
}
