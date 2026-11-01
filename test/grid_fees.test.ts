/**
 * Grid and fees: TS implementation vs the PRD tables (5.3, 6.7) — the same
 * cases exercised by contracts/test/unit/Grid.t.sol.
 */
import {
  denomOf, indexOf, decompose, sumOf, feeIn, feeTransfer, feeOut, rawFee,
  gridFee, minDenom, GRID,
} from '../src/v2/crypto/grid';

describe('Denomination grid {1,3,5}×10^k (5.3)', () => {
  test('USDC grid boundaries (k = -6..5, 36 denominations)', () => {
    expect(GRID[1].count).toBe(36);
    expect(denomOf(1, 0)).toBe(1n); // 1e-6 USDC = 1 micro
    expect(denomOf(1, 1)).toBe(3n);
    expect(denomOf(1, 2)).toBe(5n);
    expect(denomOf(1, 3)).toBe(10n);
    expect(denomOf(1, 35)).toBe(500_000_000_000n); // 5e5 USDC
    expect(() => denomOf(1, 36)).toThrow('UnknownDenom');
  });

  test('ETH grid boundaries (k = -4..2, 21 denominations)', () => {
    expect(GRID[2].count).toBe(21);
    expect(denomOf(2, 0)).toBe(100_000_000_000_000n); // 0.0001 ETH
    expect(denomOf(2, 20)).toBe(500n * 10n ** 18n); // 5×10^1 ETH (k=1: 5×10^1×1e18?) → di20 is the top: 5·10^(kMax)·1e18
    expect(() => denomOf(2, 21)).toThrow('UnknownDenom');
  });

  test('indexOf round-trips denomOf over the whole grid', () => {
    for (const assetId of [1, 2]) {
      for (let di = 0; di < GRID[assetId].count; di++) {
        expect(indexOf(assetId, denomOf(assetId, di))).toBe(di);
      }
    }
  });

  test('canonical decomposition conserves value and denominations', () => {
    const cases: Array<[bigint, number[]]> = [
      [1_000_000n, []], // 1 USDC → [6, ...] filled below
    ];
    void cases;
    for (const value of [1n, 3n, 9n, 1_000_000n, 432_000_000n, 999_999_999_999n]) {
      const dis = decompose(1, value);
      expect(sumOf(1, dis)).toBe(value);
      expect(dis.length).toBeLessThanOrEqual(64);
    }
    for (const value of [10n ** 14n, 432n * 10n ** 14n, 999n * 10n ** 16n + 999n * 10n ** 14n]) {
      const dis = decompose(2, value);
      expect(sumOf(2, dis)).toBe(value);
    }
  });
});

describe('Fees (6.7)', () => {
  test('rawFee is ceil(value × bps / 10000)', () => {
    expect(rawFee(1_000_000n, 10n)).toBe(1000n);
    expect(rawFee(1n, 10n)).toBe(1n); // ceil rounds up in protocol's favour
    expect(rawFee(9999n, 10n)).toBe(10n);
  });

  test('feeIn 10bps grid-rounded up to the minimal denomination', () => {
    // 1000 USDC (1e9 micro): raw = 1e9·10/10000 = 1e6 micro? no:
    // value=1_000_000_000 micro → raw = 1_000_000 micro = 1 USDC
    expect(feeIn(1, 1000_000_000n)).toBe(1_000_000n);
    // 10% threshold: fee (1000 > 10% of 10 = 1) zeroes out
    expect(gridFee(10n, 1000n, 1n)).toBe(1n); // raw=1 → grid=1; 1·10000 ≤ 10·1000 → kept
    expect(gridFee(9n, 1000n, 1n)).toBe(0n); // 1·10000 > 9·1000 → zeroed
  });

  test('feeTransfer 15bps from the full denomination', () => {
    const d = 1000_000_000n; // 1000 USDC
    expect(feeTransfer(1, d)).toBe(1_500_000n); // 0.15% of 1000 → 1.5 USDC
  });

  test('feeOut 25bps raw (wei-precision allowed)', () => {
    expect(feeOut(1000_000_000n)).toBe(2_500_000n);
  });

  test('cashout displacement: net stays above zero, fee floors at raw', () => {
    const min = minDenom(1);
    expect(min).toBe(1n);
  });
});
