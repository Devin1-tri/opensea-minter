# opensea-minter

Interactive CLI bot for minting NFTs from OpenSea-listed contracts across EVM
chains. Built with [ethers v6](https://docs.ethers.org/v6/) and
[Inquirer](https://www.npmjs.com/package/inquirer).

## Features

- Pick a chain from the built-in list (Ethereum, Base, Arbitrum, Optimism) or
  add a custom one — either by entering the details manually, or by searching
  [chainlist.org](https://chainlist.org) (data fetched from
  `https://chainid.network/chains.json`).
- Paste an OpenSea URL (`/assets/<chain>/<contract>/<id>`,
  `/item/<chain>/<contract>/<id>`, or `/collection/<slug>`) **or** a raw
  contract address. Collection slugs are resolved through the OpenSea API when
  `OPENSEA_API_KEY` is set.
- RPC defaults to a public endpoint for each chain. You can override per-run
  with a custom RPC (Alchemy, Infura, QuickNode, …) or via env vars
  (`ETHEREUM_RPC_URL`, `BASE_RPC_URL`, `ARBITRUM_RPC_URL`, `OPTIMISM_RPC_URL`).
- Gas is tuned automatically: EIP-1559 chains get a buffered base-fee + tip,
  legacy chains get a buffered `gasPrice`.
- The bot probes common mint signatures (`mint(uint256)`,
  `mint(address,uint256)`, `publicMint`, `mintPublic`, `claim`, `purchase`,
  `mint()`) and uses the first one whose `estimateGas` succeeds, so it works
  on most ERC-721/1155 drop contracts without per-collection ABI configuration.
- Mint price per NFT is auto-detected from common public getters (`price`,
  `mintPrice`, `MINT_PRICE`, `cost`, `PRICE`, `publicPrice`) and can be
  overridden interactively.

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

1. **Chain selection** — Ethereum / Base / Arbitrum / Optimism, or
   `Search Chainlist.org by name…` / `Enter a custom chain manually…`.
2. **RPC selection** — keep the default, use the env-var override
   (e.g. `BASE_RPC_URL`), or paste a custom URL.
3. **Target NFT** — an OpenSea URL or contract address.
4. **Quantity & price** — auto-detected mint price, with an override prompt.
5. **Gas review + confirmation** — the bot prints the mint value, max gas
   cost, and total upper bound. Confirm to send.
6. **On-chain confirmation** — the bot waits for the receipt and prints a
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
  chains.js     # Built-in chain definitions
  chainlist.js  # Chainlist.org search + cache
  opensea.js    # OpenSea URL / address parsing + slug resolution
  gas.js        # Auto fee picker (EIP-1559 + legacy)
  minter.js    # Mint function detection + dispatch
test/
  parser.test.js # Unit tests for the pure helpers
```

## License

MIT
