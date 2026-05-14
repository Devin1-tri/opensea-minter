// Helpers for picking sensible gas parameters automatically. We use the node's
// own fee data (EIP-1559 when available, legacy gas price otherwise) and apply
// a small buffer so transactions land within a few blocks under normal load.

import { formatUnits } from 'ethers';

const DEFAULT_TIP_GWEI = 1n; // 1 gwei fallback tip when the node doesn't return one.
const TIP_BUFFER_PERCENT = 25n; // bump priority fee by 25% over network suggestion
const MAXFEE_BUFFER_PERCENT = 20n; // bump max fee by 20% over (baseFee * 2 + tip)
const LEGACY_BUFFER_PERCENT = 15n; // bump legacy gasPrice by 15%

function applyPercentBuffer(value, percent) {
  return (value * (100n + percent)) / 100n;
}

function gweiFromWei(wei) {
  return Number(formatUnits(wei, 'gwei')).toFixed(3);
}

export async function pickAutoFees(provider) {
  const feeData = await provider.getFeeData();
  const block = await provider.getBlock('latest').catch(() => null);

  const supportsEip1559 = feeData.maxFeePerGas != null;

  if (supportsEip1559) {
    const networkTip = feeData.maxPriorityFeePerGas ?? 0n;
    let priorityFee = applyPercentBuffer(networkTip, TIP_BUFFER_PERCENT);
    if (priorityFee === 0n) {
      // Use a 1 gwei fallback if the node reported zero tip (common on L2s).
      priorityFee = DEFAULT_TIP_GWEI * 10n ** 9n;
    }
    const baseFee = block?.baseFeePerGas ?? 0n;
    const target = baseFee * 2n + priorityFee;
    const maxFeeRaw = feeData.maxFeePerGas ?? target;
    const maxFee = applyPercentBuffer(maxFeeRaw > target ? maxFeeRaw : target, MAXFEE_BUFFER_PERCENT);
    return {
      mode: 'eip1559',
      maxPriorityFeePerGas: priorityFee,
      maxFeePerGas: maxFee,
      baseFee,
      summary:
        `EIP-1559 — base ${gweiFromWei(baseFee)} gwei · ` +
        `tip ${gweiFromWei(priorityFee)} gwei · cap ${gweiFromWei(maxFee)} gwei`,
    };
  }

  const legacy = feeData.gasPrice ?? 0n;
  const adjusted = applyPercentBuffer(legacy || DEFAULT_TIP_GWEI * 10n ** 9n, LEGACY_BUFFER_PERCENT);
  return {
    mode: 'legacy',
    gasPrice: adjusted,
    summary: `Legacy — gasPrice ${gweiFromWei(adjusted)} gwei`,
  };
}

export function feesToTxOverrides(fees) {
  if (fees.mode === 'eip1559') {
    return {
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
  }
  return { gasPrice: fees.gasPrice };
}
