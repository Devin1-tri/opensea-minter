#!/usr/bin/env node
// Entry point. Wires together the prompts (UI), chain selection, OpenSea input
// parsing, RPC selection, gas auto-tuning, and mint dispatch.
//
// Two code paths:
//   1. OpenSea Drops API path — when OPENSEA_API_KEY is set and the target is
//      a recognised OpenSea drop. Stages (Public / Allowlist / GTD / Presale)
//      are displayed with prices + schedules; the API selects the first
//      eligible stage for the wallet and returns ready-to-sign calldata.
//   2. Generic on-chain path — falls back to probing common mint signatures
//      and reading price getters directly. Used when no API key is set or
//      the contract isn't an OpenSea-listed drop.

import 'dotenv/config';
import chalk from 'chalk';
import ora from 'ora';
import { JsonRpcProvider, Wallet, formatEther, formatUnits } from 'ethers';

import {
  printHeader,
  promptChain,
  promptRpcOverride,
  promptNftTarget,
  promptQuantity,
  promptPriceOverride,
  confirmSend,
} from './ui.js';
import {
  parseOpenseaInput,
  resolveCollectionSlug,
  resolveSlugFromContract,
} from './opensea.js';
import { openseaApiChainSlug } from './chains.js';
import { pickAutoFees, feesToTxOverrides } from './gas.js';
import {
  detectMintPriceWei,
  findWorkingMint,
  parsePriceOverride,
  explainCostBreakdown,
} from './minter.js';
import {
  fetchDrop,
  buildDropMintTransaction,
  describeStage,
} from './drops.js';

function dieWith(message, code = 1) {
  console.error(chalk.red(message));
  process.exit(code);
}

function shortExplorerTx(chain, hash) {
  return chain.explorer ? `${chain.explorer.replace(/\/$/, '')}/tx/${hash}` : hash;
}

async function main() {
  printHeader();

  if (!process.env.PRIVATE_KEY) {
    dieWith(
      'Missing PRIVATE_KEY. Copy .env.example to .env and set your wallet key, then re-run.',
    );
  }

  // ── 1. Chain + RPC ───────────────────────────────────────────────────────
  const chain = await promptChain();
  const envRpc = chain.rpcEnv ? process.env[chain.rpcEnv] : null;
  const rpcUrl = await promptRpcOverride(chain, envRpc);

  const provider = new JsonRpcProvider(rpcUrl, {
    name: chain.name,
    chainId: chain.chainId,
  });

  const spinner = ora(`Connecting to ${chain.name}…`).start();
  let network;
  try {
    network = await provider.getNetwork();
  } catch (err) {
    spinner.fail(`RPC connection failed: ${err.shortMessage || err.message}`);
    process.exit(1);
  }
  if (Number(network.chainId) !== chain.chainId) {
    spinner.fail(
      `RPC chain id mismatch: expected ${chain.chainId}, got ${network.chainId}. ` +
        'Pick a different RPC URL.',
    );
    process.exit(1);
  }
  spinner.succeed(`Connected to ${chain.name} (chainId ${chain.chainId}).`);

  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);
  console.log(
    chalk.gray(
      `Wallet ${wallet.address} — balance ${formatEther(balance)} ${chain.currency.symbol}`,
    ),
  );

  // ── 2. NFT target ────────────────────────────────────────────────────────
  const targetInput = await promptNftTarget();
  const parsed = parseOpenseaInput(targetInput);
  if (!parsed.ok) dieWith(parsed.error);

  const apiKey = process.env.OPENSEA_API_KEY || null;
  const apiChainSlug = openseaApiChainSlug(chain.chainId);

  // Resolve a contract address and (when possible) an OpenSea collection slug.
  let contractAddress = parsed.contractAddress;
  let collectionSlug = parsed.slug || null;

  if (!contractAddress && parsed.kind === 'collection') {
    const slugSpinner = ora(`Resolving OpenSea collection "${parsed.slug}"…`).start();
    try {
      const resolved = await resolveCollectionSlug(parsed.slug, apiKey);
      contractAddress = resolved.contractAddress;
      slugSpinner.succeed(`Resolved to contract ${contractAddress}.`);
    } catch (err) {
      slugSpinner.fail(err.message);
      process.exit(1);
    }
  }
  if (!contractAddress) dieWith('No contract address was resolved from the input.');

  if (!collectionSlug && apiKey && apiChainSlug) {
    const slugSpinner = ora('Looking up OpenSea collection slug for this contract…').start();
    collectionSlug = await resolveSlugFromContract({
      apiChainSlug,
      contractAddress,
      apiKey,
    });
    if (collectionSlug) slugSpinner.succeed(`OpenSea collection: ${collectionSlug}`);
    else slugSpinner.warn('No OpenSea collection found for this contract (continuing without drop info).');
  }

  // ── 3. Try the OpenSea Drops API path first ─────────────────────────────
  if (apiKey && collectionSlug) {
    const handled = await tryDropsApiFlow({
      chain,
      wallet,
      provider,
      slug: collectionSlug,
      apiKey,
    });
    if (handled) return; // success or user-aborted
    console.log(chalk.gray('Falling back to generic on-chain minting…'));
  } else if (!apiKey) {
    console.log(
      chalk.gray(
        'No OPENSEA_API_KEY set — skipping drop stage/eligibility detection. ' +
          'Add a key to your .env for the full experience.',
      ),
    );
  }

  // ── 4. Generic on-chain fallback ─────────────────────────────────────────
  await genericMintFlow({ chain, wallet, provider, contractAddress });
}

async function tryDropsApiFlow({ chain, wallet, provider, slug, apiKey }) {
  const dropSpinner = ora(`Fetching OpenSea drop info for "${slug}"…`).start();
  let drop;
  try {
    drop = await fetchDrop(slug, apiKey);
  } catch (err) {
    dropSpinner.fail(`Could not fetch drop: ${err.message}`);
    return false;
  }
  if (!drop.stages || drop.stages.length === 0) {
    dropSpinner.fail('OpenSea returned no stages for this collection — not a drop.');
    return false;
  }
  dropSpinner.succeed(
    `Drop "${drop.name}" — ${drop.totalMinted ?? '?'} / ${drop.totalSupply ?? '?'} minted, ` +
      `${drop.stages.length} stage(s).`,
  );

  // Show each stage with its price + window + per-wallet cap + status.
  console.log('');
  console.log(chalk.bold('Stages'));
  for (const stage of drop.stages) {
    const colour =
      stage.status === 'active' ? chalk.green : stage.status === 'upcoming' ? chalk.yellow : chalk.gray;
    console.log(`  ${colour('•')} ${describeStage(stage, chain.currency.symbol)}`);
  }
  console.log('');

  const activeStages = drop.stages.filter((s) => s.status === 'active');
  if (activeStages.length === 0) {
    console.log(chalk.yellow('No stages are currently active. OpenSea will reject the mint request.'));
  }

  // Quantity — hint with max_per_wallet if available.
  const maxPer = activeStages
    .map((s) => s.maxPerWallet)
    .filter((v) => v != null)
    .reduce((acc, v) => (acc == null || v > acc ? v : acc), null);
  const defaultQty = 1;
  if (maxPer != null) {
    console.log(chalk.gray(`Max per wallet (active stages): ${maxPer.toString()}`));
  }
  const quantity = await promptQuantity(defaultQty);

  // Eligibility check + tx build — done in a single API call that returns 422
  // when the wallet isn't eligible. This is also what tells us which stage
  // (and what price) actually applies to this wallet.
  const buildSpinner = ora('Asking OpenSea for an eligible-stage mint transaction…').start();
  let mintTx;
  try {
    mintTx = await buildDropMintTransaction({
      slug,
      minter: wallet.address,
      quantity,
      apiKey,
    });
  } catch (err) {
    if (err.status === 422) {
      buildSpinner.fail(
        `Wallet ${wallet.address} is not eligible to mint right now ` +
          `(probably not on the allowlist, or wallet limit reached).`,
      );
    } else if (err.status === 409) {
      buildSpinner.fail('Drop is not currently active for minting (not started / ended / paused).');
    } else {
      buildSpinner.fail(err.message);
    }
    return true; // handled — don't fall back to generic
  }
  const valueWei = mintTx.value;
  const pricePerToken = quantity > 0 ? valueWei / BigInt(quantity) : 0n;
  buildSpinner.succeed(
    `Eligible — OpenSea built a tx for ${quantity}× at ${formatEther(pricePerToken)} ${chain.currency.symbol} each.`,
  );

  // Try to identify which stage the API picked by matching the per-token price.
  const matchedStage = drop.stages.find((s) => s.priceWei === pricePerToken && s.status === 'active');
  if (matchedStage) {
    console.log(chalk.gray(`Stage applied: ${matchedStage.label} (${matchedStage.type})`));
  }

  // Auto fees + gas estimate against the OpenSea-built calldata.
  const feeSpinner = ora('Reading network fees…').start();
  let fees;
  try {
    fees = await pickAutoFees(provider);
  } catch (err) {
    feeSpinner.fail(`Could not read network fees: ${err.shortMessage || err.message}`);
    return true;
  }
  feeSpinner.succeed(`Auto gas — ${fees.summary}`);

  const estimateSpinner = ora('Estimating gas for the mint call…').start();
  let gasLimit;
  try {
    gasLimit = await provider.estimateGas({
      from: wallet.address,
      to: mintTx.to,
      data: mintTx.data,
      value: valueWei,
    });
  } catch (err) {
    estimateSpinner.fail(
      `Gas estimate failed: ${err.shortMessage || err.message}. The tx would likely revert; aborting.`,
    );
    return true;
  }
  estimateSpinner.succeed(`Estimated gas ${gasLimit.toString()}.`);

  const maxGasCost =
    fees.mode === 'eip1559' ? fees.maxFeePerGas * gasLimit : fees.gasPrice * gasLimit;

  const ok = await confirmSend({
    Chain: `${chain.name} (chainId ${chain.chainId})`,
    Contract: mintTx.to,
    Quantity: String(quantity),
    'Mint price/each': `${formatEther(pricePerToken)} ${chain.currency.symbol}`,
    'Mint total': `${formatEther(valueWei)} ${chain.currency.symbol}`,
    'Gas (upper bound)': `${formatEther(maxGasCost)} ${chain.currency.symbol}`,
    'Total upper bound': `${formatEther(valueWei + maxGasCost)} ${chain.currency.symbol}`,
    Wallet: wallet.address,
    Stage: matchedStage ? `${matchedStage.label} (${matchedStage.type})` : 'auto-picked by OpenSea',
  });
  if (!ok) {
    console.log(chalk.gray('Aborted.'));
    return true;
  }

  const sendSpinner = ora('Sending mint transaction…').start();
  let txResponse;
  try {
    txResponse = await wallet.sendTransaction({
      to: mintTx.to,
      data: mintTx.data,
      value: valueWei,
      gasLimit: (gasLimit * 12n) / 10n,
      ...feesToTxOverrides(fees),
    });
  } catch (err) {
    sendSpinner.fail(`Transaction send failed: ${err.shortMessage || err.message}`);
    return true;
  }
  sendSpinner.succeed(`Submitted: ${shortExplorerTx(chain, txResponse.hash)}`);

  await awaitReceipt(txResponse);
  return true;
}

async function genericMintFlow({ chain, wallet, provider, contractAddress }) {
  const quantity = await promptQuantity();

  const priceSpinner = ora('Detecting mint price…').start();
  const { priceWei: detectedWei, source } = await detectMintPriceWei(provider, contractAddress);
  if (detectedWei != null) {
    priceSpinner.succeed(
      `Detected mint price via ${source}(): ${formatEther(detectedWei)} ${chain.currency.symbol}.`,
    );
  } else {
    priceSpinner.warn('Could not auto-detect mint price.');
  }

  const overrideInput = await promptPriceOverride(
    detectedWei != null ? formatEther(detectedWei) : null,
    chain.currency.symbol,
  );
  let priceWei;
  try {
    const overrideWei = parsePriceOverride(overrideInput);
    priceWei = overrideWei != null ? overrideWei : detectedWei ?? 0n;
  } catch (err) {
    dieWith(err.message);
  }

  const feeSpinner = ora('Reading network fees…').start();
  let fees;
  try {
    fees = await pickAutoFees(provider);
  } catch (err) {
    feeSpinner.fail(`Could not read network fees: ${err.shortMessage || err.message}`);
    process.exit(1);
  }
  feeSpinner.succeed(`Auto gas — ${fees.summary}`);

  const dryRunSpinner = ora('Finding a working mint function (dry run)…').start();
  let mintPlan;
  try {
    mintPlan = await findWorkingMint({
      wallet,
      address: contractAddress,
      quantity,
      valueWei: priceWei * BigInt(quantity),
    });
  } catch (err) {
    dryRunSpinner.fail(err.message);
    process.exit(1);
  }
  dryRunSpinner.succeed(
    `Will call ${chalk.bold(mintPlan.fnName)} — estimated gas ${mintPlan.gasLimit.toString()}.`,
  );

  const cost = explainCostBreakdown({
    quantity,
    priceWei,
    fees,
    gasLimit: mintPlan.gasLimit,
    currencySymbol: chain.currency.symbol,
  });

  const ok = await confirmSend({
    Chain: `${chain.name} (chainId ${chain.chainId})`,
    Contract: contractAddress,
    Quantity: String(quantity),
    'Mint price/each': `${formatEther(priceWei)} ${chain.currency.symbol}`,
    'Mint total': cost.mintValue,
    'Gas (upper bound)': cost.maxGasCost,
    'Total upper bound': cost.maxTotal,
    Wallet: wallet.address,
    Function: mintPlan.signature,
  });
  if (!ok) {
    console.log(chalk.gray('Aborted.'));
    process.exit(0);
  }

  const sendSpinner = ora('Sending mint transaction…').start();
  let txResponse;
  try {
    const overrides = {
      value: priceWei * BigInt(quantity),
      gasLimit: (mintPlan.gasLimit * 12n) / 10n,
      ...feesToTxOverrides(fees),
    };
    txResponse = await mintPlan.contract[mintPlan.fnName](...mintPlan.args, overrides);
  } catch (err) {
    sendSpinner.fail(`Transaction send failed: ${err.shortMessage || err.message}`);
    process.exit(1);
  }
  sendSpinner.succeed(`Submitted: ${shortExplorerTx(chain, txResponse.hash)}`);

  await awaitReceipt(txResponse);
}

async function awaitReceipt(txResponse) {
  const confirmSpinner = ora('Waiting for confirmation…').start();
  try {
    const receipt = await txResponse.wait();
    if (receipt.status === 1) {
      confirmSpinner.succeed(
        `Mint confirmed in block ${receipt.blockNumber}. ` +
          `Effective gas price ${formatUnits(receipt.gasPrice ?? 0n, 'gwei')} gwei.`,
      );
    } else {
      confirmSpinner.fail('Transaction reverted on-chain.');
      process.exit(1);
    }
  } catch (err) {
    confirmSpinner.fail(`Confirmation error: ${err.shortMessage || err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(chalk.red('\nUnexpected error:'), err);
  process.exit(1);
});
