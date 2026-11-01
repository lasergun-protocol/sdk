/**
 * Denomination grid {1,3,5}×10^k and protocol fees.
 * Mirrors contracts/src/lib/DenomGrid.sol and contracts/src/lib/Fees.sol.
 * assetId: 1 = USDC (6 decimals), 2 = ETH (18 decimals, grid unit 0.0001).
 */
export const USDC_SCALE = 1_000_000n;
export const ETH_MIN_DENOM = 100_000_000_000_000n; // 1e14 wei

export const GRID: Record<number, { count: number; kMin: number }> = {
  1: { count: 36, kMin: -6 },
  2: { count: 21, kMin: -4 },
};

const DIGITS = [1n, 3n, 5n];

export function denomOf(assetId: number, di: number): bigint {
  const g = GRID[assetId];
  if (!g || di >= g.count) throw new Error('UnknownDenom');
  const k = Math.floor(di / 3) + g.kMin;
  const digit = DIGITS[di % 3];
  if (assetId === 1) return digit * 10n ** BigInt(k + 6); // micro-USDC
  return digit * 10n ** BigInt(k + 4) * ETH_MIN_DENOM; // wei
}

export function indexOf(assetId: number, value: bigint): number {
  if (value === 0n) throw new Error('UnknownDenom');
  let trailing = 0;
  let m = value;
  const unit = assetId === 1 ? 1n : ETH_MIN_DENOM;
  if (assetId === 2) {
    if (value % ETH_MIN_DENOM !== 0n) throw new Error('UnknownDenom');
    m = value / ETH_MIN_DENOM;
  }
  while (m > 0n && m % 10n === 0n) {
    m /= 10n;
    trailing++;
  }
  const di = DIGITS.findIndex((d) => d === m);
  if (di < 0) throw new Error('UnknownDenom');
  const idx = di + trailing * 3;
  if (idx >= GRID[assetId].count) throw new Error('UnknownDenom');
  void unit;
  return idx;
}

export function sumOf(assetId: number, dis: ArrayLike<number>): bigint {
  let total = 0n;
  for (let j = 0; j < dis.length; j++) total += denomOf(assetId, dis[j]);
  return total;
}

export function minDenom(assetId: number): bigint {
  return assetId === 1 ? 1n : ETH_MIN_DENOM;
}

export function maxAmount(assetId: number): bigint {
  return assetId === 1 ? 999_999_999_999n : 9_999_999n * ETH_MIN_DENOM;
}

/**
 * Canonical decomposition into at most `maxNotes` grid notes (table 5 of the
 * PRD: greedy {1,3,5}×10^k from the largest denomination down). Greedy over
 * the {1,3,5} grid always terminates: every remainder is representable.
 */
export function decompose(assetId: number, value: bigint, maxNotes = 64): number[] {
  const dis: number[] = [];
  let rest = value;
  for (let di = GRID[assetId].count - 1; di >= 0 && rest > 0n; di--) {
    const d = denomOf(assetId, di);
    while (rest >= d) {
      dis.push(di);
      rest -= d;
      if (dis.length > maxNotes) throw new Error('BatchTooLarge');
    }
  }
  if (rest !== 0n) throw new Error('UnknownDenom');
  return dis;
}

// ── fees (6.7) ──────────────────────────────────────────────────────

export const FEE_IN_BPS = 10n;
export const FEE_TRANSFER_BPS = 15n;
export const FEE_OUT_BPS = 25n;
export const FEE_CAP_BPS = 100n;
export const FEE_GRID_CAP_BPS = 1000n; // 10% zeroing threshold

export function rawFee(value: bigint, bps: bigint): bigint {
  return (value * bps + 9999n) / 10000n; // ceil, in favour of the protocol
}

export function gridFee(value: bigint, bps: bigint, minDenom_: bigint): bigint {
  let f = rawFee(value, bps);
  if (f === 0n) return 0n;
  const rem = f % minDenom_;
  if (rem !== 0n) f += minDenom_ - rem;
  if (f * 10000n > value * FEE_GRID_CAP_BPS) return 0n;
  if (value - f < minDenom_) return 0n;
  return f;
}

export function feeIn(assetId: number, deposited: bigint): bigint {
  return gridFee(deposited, FEE_IN_BPS, minDenom(assetId));
}

export function feeTransfer(assetId: number, denomValue: bigint): bigint {
  return gridFee(denomValue, FEE_TRANSFER_BPS, minDenom(assetId));
}

export function feeOut(denomValue: bigint): bigint {
  return rawFee(denomValue, FEE_OUT_BPS);
}
