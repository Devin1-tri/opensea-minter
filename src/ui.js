// Inquirer-powered prompt helpers. Keeps prompt strings/colours in one place so
// src/index.js stays focused on the workflow.

import inquirer from 'inquirer';
import chalk from 'chalk';
import { BUILTIN_CHAINS } from './chains.js';
import {
  loadChainlist,
  searchChains,
  getPublicRpcs,
  summariseChainForChoice,
  chainlistEntryToBotChain,
} from './chainlist.js';

const HEADER = chalk.bold.cyan('OpenSea Minter');

export function printHeader() {
  console.log('');
  console.log(HEADER);
  console.log(chalk.gray('Interactive NFT minting bot for OpenSea-listed contracts.'));
  console.log('');
}

const CUSTOM_MANUAL = '__custom_manual__';
const CUSTOM_CHAINLIST = '__custom_chainlist__';

export async function promptChain() {
  const choices = [
    ...Object.values(BUILTIN_CHAINS).map((c) => ({
      name: `${c.name} (chainId ${c.chainId})`,
      value: c.key,
    })),
    new inquirer.Separator(),
    { name: 'Search Chainlist.org by name…', value: CUSTOM_CHAINLIST },
    { name: 'Enter a custom chain manually…', value: CUSTOM_MANUAL },
  ];

  const { selection } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selection',
      message: 'Select a chain:',
      choices,
      pageSize: 12,
    },
  ]);

  if (selection === CUSTOM_MANUAL) return promptCustomChainManual();
  if (selection === CUSTOM_CHAINLIST) return promptCustomChainFromChainlist();
  return BUILTIN_CHAINS[selection];
}

async function promptCustomChainManual() {
  const answers = await inquirer.prompt([
    { type: 'input', name: 'name', message: 'Chain name:', validate: (v) => !!v.trim() || 'Required' },
    {
      type: 'input',
      name: 'chainId',
      message: 'Chain ID (decimal):',
      validate: (v) => (/^\d+$/.test(v.trim()) ? true : 'Must be a positive integer'),
    },
    {
      type: 'input',
      name: 'rpcUrl',
      message: 'RPC URL (https://…):',
      validate: (v) => (/^https?:\/\//i.test(v.trim()) ? true : 'Must start with http(s)://'),
    },
    {
      type: 'input',
      name: 'explorer',
      message: 'Block explorer URL (optional):',
      default: '',
    },
    {
      type: 'input',
      name: 'currencySymbol',
      message: 'Native currency symbol:',
      default: 'ETH',
    },
    {
      type: 'input',
      name: 'currencyDecimals',
      message: 'Native currency decimals:',
      default: '18',
      validate: (v) => (/^\d+$/.test(v.trim()) ? true : 'Must be a non-negative integer'),
    },
  ]);

  return {
    key: `custom-${answers.chainId}`,
    name: answers.name.trim(),
    chainId: Number(answers.chainId),
    rpcUrl: answers.rpcUrl.trim(),
    explorer: answers.explorer.trim(),
    currency: {
      name: answers.currencySymbol.trim() || 'ETH',
      symbol: answers.currencySymbol.trim() || 'ETH',
      decimals: Number(answers.currencyDecimals),
    },
    rpcEnv: null,
    source: 'manual',
  };
}

async function promptCustomChainFromChainlist() {
  console.log(chalk.gray('Loading Chainlist.org data…'));
  try {
    await loadChainlist();
  } catch (err) {
    console.log(chalk.yellow(`Could not load Chainlist (${err.message}). Falling back to manual entry.`));
    return promptCustomChainManual();
  }

  while (true) {
    const { query } = await inquirer.prompt([
      {
        type: 'input',
        name: 'query',
        message: 'Search chain by name or chain id (blank to cancel):',
      },
    ]);
    const q = query.trim();
    if (!q) return promptCustomChainManual();

    const results = await searchChains(q);
    if (results.length === 0) {
      console.log(chalk.yellow('No matching chains. Try a different query.'));
      continue;
    }

    const { picked } = await inquirer.prompt([
      {
        type: 'list',
        name: 'picked',
        message: `Matches for "${q}":`,
        choices: [
          ...results.map((c) => ({ name: summariseChainForChoice(c), value: c.chainId })),
          new inquirer.Separator(),
          { name: '↩ search again', value: '__again__' },
        ],
        pageSize: 12,
      },
    ]);
    if (picked === '__again__') continue;

    const chain = results.find((c) => c.chainId === picked);
    const rpcs = getPublicRpcs(chain);
    if (rpcs.length === 0) {
      console.log(
        chalk.yellow(
          `No public RPCs are advertised for ${chain.name} on Chainlist. Enter one manually below.`,
        ),
      );
      const { manualRpc } = await inquirer.prompt([
        {
          type: 'input',
          name: 'manualRpc',
          message: 'Custom RPC URL for this chain:',
          validate: (v) => (/^https?:\/\//i.test(v.trim()) ? true : 'Must start with http(s)://'),
        },
      ]);
      return chainlistEntryToBotChain(chain, manualRpc.trim());
    }

    const { rpcUrl } = await inquirer.prompt([
      {
        type: 'list',
        name: 'rpcUrl',
        message: `Pick an RPC for ${chain.name}:`,
        choices: [...rpcs, new inquirer.Separator(), 'Enter a custom RPC URL…'],
        pageSize: 10,
      },
    ]);
    if (rpcUrl === 'Enter a custom RPC URL…') {
      const { manualRpc } = await inquirer.prompt([
        {
          type: 'input',
          name: 'manualRpc',
          message: 'Custom RPC URL:',
          validate: (v) => (/^https?:\/\//i.test(v.trim()) ? true : 'Must start with http(s)://'),
        },
      ]);
      return chainlistEntryToBotChain(chain, manualRpc.trim());
    }
    return chainlistEntryToBotChain(chain, rpcUrl);
  }
}

export async function promptRpcOverride(chain, envOverride) {
  if (envOverride) {
    const { useEnv } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'useEnv',
        message: `Use RPC from ${chain.rpcEnv}? (${maskRpc(envOverride)})`,
        default: true,
      },
    ]);
    if (useEnv) return envOverride;
  }

  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: `RPC for ${chain.name}:`,
      choices: [
        { name: `Default — ${maskRpc(chain.rpcUrl)}`, value: 'default' },
        { name: 'Custom (Alchemy, Infura, QuickNode, …)', value: 'custom' },
      ],
    },
  ]);
  if (mode === 'default') return chain.rpcUrl;

  const { custom } = await inquirer.prompt([
    {
      type: 'input',
      name: 'custom',
      message: 'Custom RPC URL:',
      validate: (v) => (/^https?:\/\//i.test(v.trim()) ? true : 'Must start with http(s)://'),
    },
  ]);
  return custom.trim();
}

function maskRpc(url) {
  if (typeof url !== 'string') return '';
  // Hide API keys at the end of common provider URLs.
  return url.replace(/(\/v[0-9]+\/)([A-Za-z0-9_-]{6,})/g, (_, prefix, key) => `${prefix}${key.slice(0, 4)}…${key.slice(-2)}`);
}

export async function promptNftTarget() {
  const { target } = await inquirer.prompt([
    {
      type: 'input',
      name: 'target',
      message: 'OpenSea URL or NFT contract address:',
      validate: (v) => (v.trim() ? true : 'Required'),
    },
  ]);
  return target.trim();
}

export async function promptQuantity(defaultValue = 1) {
  const { qty } = await inquirer.prompt([
    {
      type: 'input',
      name: 'qty',
      message: 'How many to mint?',
      default: String(defaultValue),
      validate: (v) => (/^[1-9]\d*$/.test(v.trim()) ? true : 'Enter a positive integer'),
    },
  ]);
  return Number(qty);
}

export async function promptPriceOverride(detected, currencySymbol) {
  const message =
    detected != null
      ? `Detected mint price ${detected} ${currencySymbol}. Override? (blank to keep)`
      : `Could not detect mint price. Enter price per NFT in ${currencySymbol} (blank = 0)`;
  const { override } = await inquirer.prompt([
    { type: 'input', name: 'override', message, default: '' },
  ]);
  return override.trim();
}

export async function confirmSend(summary) {
  console.log('');
  console.log(chalk.bold('Transaction summary'));
  for (const [label, value] of Object.entries(summary)) {
    console.log(`  ${chalk.gray(label.padEnd(16))}${value}`);
  }
  console.log('');
  const { ok } = await inquirer.prompt([
    { type: 'confirm', name: 'ok', message: 'Send transaction?', default: false },
  ]);
  return ok;
}
