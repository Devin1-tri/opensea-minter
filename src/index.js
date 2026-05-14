#!/usr/bin/env node
// Entry point. Wires together the prompts (UI), chain selection, OpenSea input
// parsing, RPC selection, gas auto-tuning, and mint dispatch.

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
import { parseOpenseaInput, resolveCollectionSlug } from './opensea.js';
import { pickAutoFees } from './gas.js';
import {
  detectMintPriceWei,
  findWorkingMint,
  parsePriceOverride,
  explainCostBreakdown,
} from './minter.js';
import { feesToTxOverrides } from './gas.js';

function dieWith(message, code = 1) {
  console.error(chalk.red(message));
  process.exit(code);
}

async function main() {
  printHeader();

  if (!process.env.PRIVATE_KEY) {
    dieWith(
      'Missing PRIVATE_KEY. Copy .env.example to .env and set your wallet key, then re-run.',
    );
  }

  // 1. Chain selection
  const chain = await promptChain();
  const envRpc = chain.rpcEnv ? process.env[chain.rpcEnv] : null;
  const rpcUrl = await promptRpcOverride(chain, envRpc);

  const provider = new JsonRpcProvider(rpcUrl, {
    name: chain.name,
    chainId: chain.chainId,
  });

  // Sanity-check the RPC + chain id match.
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

  // 2. NFT target
  const targetInput = await promptNftTarget();
  const parsed = parseOpenseaInput(targetInput);
  if (!parsed.ok) dieWith(parsed.error);

  let contractAddress = parsed.contractAddress;
  if (!contractAddress && parsed.kind === 'collection') {
    const slugSpinner = ora(`Resolving OpenSea collection "${parsed.slug}"…`).start();
    try {
      const resolved = await resolveCollectionSlug(parsed.slug, process.env.OPENSEA_API_KEY);
      contractAddress = resolved.contractAddress;
      slugSpinner.succeed(`Resolved to contract ${contractAddress}.`);
    } catch (err) {
      slugSpinner.fail(err.message);
      process.exit(1);
    }
  }
  if (!contractAddress) dieWith('No contract address was resolved from the input.');

  // 3. Quantity + price
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
    if (overrideWei != null) {
      priceWei = overrideWei;
    } else {
      priceWei = detectedWei ?? 0n;
    }
  } catch (err) {
    dieWith(err.message);
  }

  // 4. Auto fees
  const feeSpinner = ora('Reading network fees…').start();
  let fees;
  try {
    fees = await pickAutoFees(provider);
  } catch (err) {
    feeSpinner.fail(`Could not read network fees: ${err.shortMessage || err.message}`);
    process.exit(1);
  }
  feeSpinner.succeed(`Auto gas — ${fees.summary}`);

  // 5. Mint function discovery + dry run
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

  // 6. Send transaction
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
  const txUrl = chain.explorer ? `${chain.explorer.replace(/\/$/, '')}/tx/${txResponse.hash}` : txResponse.hash;
  sendSpinner.succeed(`Submitted: ${txUrl}`);

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
