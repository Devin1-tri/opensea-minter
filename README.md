# opensea-minter

Interactive CLI bot for minting NFTs from OpenSea-listed contracts across EVM
chains. Built with [ethers v6](https://docs.ethers.org/v6/) and
[Inquirer](https://www.npmjs.com/package/inquirer).

## Features

- Pick a chain from the built-in list (Ethereum, Base, Arbitrum, Optimism, Polygon) or
  add a custom one — either by entering the details manually, or by searching
  [chainlist.org](https://chainlist.org) (data fetched from
  `https://chainid.network/chains.json`).
- Paste an OpenSea URL (`/assets/<chain>/<contract>/<id>`,
  `/item/<chain>/<contract>/<id>`, or `/collection/<slug>`) **or** a raw
  contract address. The bot uses the OpenSea API to resolve a contract back to
  its collection slug when `OPENSEA_API_KEY` is set.
- **Drop stage + eligibility detection (OpenSea Drops API).** When the target
  is an OpenSea-listed drop, the bot lists every stage (Public, Allowlist,
  GTD, Presale, …) with its **price**, **start/end time**, **per-wallet cap**,
  and **active/upcoming/ended** status. It then asks OpenSea to build a mint
  transaction for the connected wallet — OpenSea picks the first eligible
  stage automatically and the bot reports back which stage and price were
  applied. If the wallet isn't on the allowlist or the wallet limit is reached,
  OpenSea returns 422 and the bot tells you why instead of just reverting.
- RPC defaults to a public endpoint for each chain. You can override per-run
  with a custom RPC (Alchemy, Infura, QuickNode, …) or via env vars
  (`ETHEREUM_RPC_URL`, `BASE_RPC_URL`, `ARBITRUM_RPC_URL`, `OPTIMISM_RPC_URL`,
  `POLYGON_RPC_URL`).
- Gas is tuned automatically: EIP-1559 chains get a buffered base-fee + tip,
  legacy chains get a buffered `gasPrice`.
- For non-drop contracts (or when no API key is set), the bot falls back to a
  generic mint flow: it probes common signatures (`mint(uint256)`,
  `mint(address,uint256)`, `publicMint`, `mintPublic`, `claim`, `purchase`,
  `mint()`) and uses the first one whose `estimateGas` succeeds, reading
  price from common getters (`price`, `mintPrice`, `MINT_PRICE`, `cost`,
  `PRICE`, `publicPrice`) with an override prompt. The Drops API path also
  automatically falls back here when OpenSea returns an unexpected error
  (e.g. 500) for the mint build — the collection may not actually be an
  OpenSea-managed drop.
- **Chain-mismatch guard.** When you paste a `/collection/<slug>` URL or an
  `/assets/<chain>/.../...` URL that lives on a different chain than the one
  you picked, the bot stops immediately with an actionable error instead of
  trying to mint a Base contract on Ethereum (and so on).

## Requirements

- Node.js **18+** (uses native `fetch`).
- An EVM wallet private key with enough native token to cover mint + gas.

## Quick start

```bash
git clone https://github.com/Devin1-tri/opensea-minter.git
cd opensea-minter
npm install
cp .env.example .env
# edit .env and put your PRIVATE_KEY in (and optionally an OPENSEA_API_KEY /
# custom RPC URLs)
npm start
```

You'll be walked through:

1. **Chain selection** — Ethereum / Base / Arbitrum / Optimism / Polygon, or
   `Search Chainlist.org by name…` / `Enter a custom chain manually…`.
2. **RPC selection** — keep the default, use the env-var override
   (e.g. `BASE_RPC_URL`), or paste a custom URL.
3. **Target NFT** — an OpenSea URL or contract address. With an API key the
   bot resolves it to a collection slug and shows the drop's stages.
4. **Stage / eligibility (drops only)** — the bot prints all stages with
   prices and schedules, then asks OpenSea to build a mint transaction for
   your wallet, which doubles as an eligibility check.
5. **Quantity & price** — for drops, the price comes from OpenSea's response
   (per the eligible stage). For non-drops, the bot auto-detects price from
   common getters and lets you override.
6. **Gas review + confirmation** — the bot prints the mint value, max gas
   cost, and total upper bound. Confirm to send.
7. **On-chain confirmation** — the bot waits for the receipt and prints a
   block explorer link.

## Configuration

All configuration lives in `.env`:

```dotenv
PRIVATE_KEY=0x...
# Optional custom RPCs
ETHEREUM_RPC_URL=
BASE_RPC_URL=
ARBITRUM_RPC_URL=
OPTIMISM_RPC_URL=
POLYGON_RPC_URL=
# Optional, only needed for /collection/<slug> URLs
OPENSEA_API_KEY=
```

## Security notes

- Never commit your `.env`. The included `.gitignore` excludes it.
- The bot only ever signs transactions you confirm interactively. There is no
  unattended mode.
- Always sanity-check the contract address and mint price before confirming.
  Auto-detected prices may be wrong if the contract uses an unusual getter.

## Project layout

```
src/
  index.js       # CLI entry point — orchestrates the flow
  ui.js          # Inquirer prompts
  chains.js      # Built-in chain definitions + OpenSea chain id map
  chainlist.js   # Chainlist.org search + cache
  opensea.js     # OpenSea URL / address parsing + slug resolution
  drops.js       # OpenSea Drops API client (stages + build mint tx)
  gas.js         # Auto fee picker (EIP-1559 + legacy)
  minter.js      # Generic mint function detection + dispatch
  chain-check.js # Chain-mismatch guard (pure helper)
test/
  parser.test.js      # Unit tests for OpenSea URL / price parsing
  drops.test.js       # Unit tests for the Drops API client (fetch-stubbed)
  chain-check.test.js # Tests for the chain-mismatch guard + slug resolver
```

## License

MIT
