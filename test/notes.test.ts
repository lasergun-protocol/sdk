/**
 * Notes layer: ring assembly, spend output conservation (6.6, 6.7), and the
 * spend plan that feeds LaserGunCore.spend — mirrored from notes fuzz.
 */
import {
  pickRing, buildChangeBatch, buildPayeeBatchTo, signSpend,
  cashoutAmount, nullifierOfKey, computeKeyImage, MIN_RING, MAX_RING,
} from '../src/v2/core/notes';
import { lsagVerify, hpForRing, messageHash } from '../src/v2/crypto/lsag';
import { mulG, encode } from '../src/v2/crypto/bn254';
import { randomScalar } from '../src/v2/crypto/stealth';
import { decompose, sumOf, feeTransfer, denomOf, indexOf, maxAmount } from '../src/v2/crypto/grid';

function ring(n: number): Uint8Array[] {
  return Array.from({ length: n }, () => encode(mulG(randomScalar())));
}

describe('Ring assembly (6.6)', () => {
  test('real commitment is included exactly once', () => {
    const r = ring(32);
    const real = r[7];
    const picked = pickRing(r, real, 16);
    expect(picked.length).toBe(16);
    expect(picked.filter((p) => Buffer.from(p).equals(Buffer.from(real))).length).toBe(1);
  });

  test('ring size bounds', () => {
    expect(MIN_RING).toBe(16);
    expect(MAX_RING).toBe(64);
  });
});

describe('Spend conservation (6.7)', () => {
  test('change batch: sum(change) + feeTransfer == denom', () => {
    const secret = randomScalar();
    const assetId = 1;
    const denom = 1000_000_000n; // 1000 USDC = di 27 in the {1,3,5}×10^k grid
    const keep = denom - feeTransfer(assetId, denom); // 998_500_000
    const batch = buildChangeBatch(assetId, keep, secret, secret);
    expect(feeTransfer(assetId, denom)).toBe(1_500_000n); // 15 bps
    expect(sumOf(assetId, batch.di)).toBe(keep);
    expect(sumOf(assetId, batch.di) + feeTransfer(assetId, denom)).toBe(denom);
    expect(batch.E.length).toBe(batch.X.length);
    expect(batch.X.length).toBe(batch.di.length);
  });

  test('payee batch to a meta-address is recoverable by the recipient', async () => {
    const { Wallet } = await import('ethers');
    const { deriveKeys } = await import('../src/v2/crypto/keys');
    const recipient = await deriveKeys(new Wallet('0x'.padEnd(66, '3')));
    const amount = 765_000_000n;
    const batch = buildPayeeBatchTo(1, amount, recipient.metaAddress);
    expect(sumOf(1, batch.di)).toBe(amount);
    // each note must recover with the recipient's keys
    for (let j = 0; j < batch.E.length; j++) {
      const { tryRecoverNote } = await import('../src/v2/crypto/stealth');
      const back = tryRecoverNote(
        recipient.viewSecret, recipient.spendSecret, batch.E[j], batch.X[j],
      );
      expect(back.owned).toBe(true);
    }
  });
});

describe('signSpend produces verifiable LSAG (client side)', () => {
  test('self-verify change spend of ring 16', () => {
    const secret = randomScalar();
    const realY = mulG(secret);
    const r = ring(15);
    const full = [...r, encode(realY)];
    const picked = pickRing(full, encode(realY), 16);
    const realIndex = picked.findIndex((p) => Buffer.from(p).equals(Buffer.from(encode(realY))));
    const batch = buildChangeBatch(1, 100_000_000n, secret, secret);
    const signed = signSpend(
      {
        assetId: 1, di: 12, recipient: '0x' + '11'.repeat(20),
        chainId: 8453n, ring: picked,
        outputs: { change: batch },
      },
      realIndex, secret,
    );
    const m = messageHash(
      1, 12, '0x' + '11'.repeat(20), 8453n, { change: batch },
    );
    const hp = hpForRing(picked);
    expect(lsagVerify(
      m, picked, hp, signed.I, signed.c1, signed.s,
    )).toBe(true);
    // nullifier binds the key image
    expect(nullifierOfKey(signed.I)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Buffer.from(computeKeyImage(secret, picked[realIndex])).toString('hex'))
      .toBe(Buffer.from(signed.I).toString('hex'));
  });
});

describe('Cashout (10.3)', () => {
  test('net = denom − feeOut(denom)', () => {
    const denomDi = indexOf(1, 1000_000_000n); // 1000 USDC
    const denom = denomOf(1, denomDi);
    expect(denom).toBe(1000_000_000n);
    const { net, fee } = cashoutAmount(1, denomDi);
    expect(fee).toBe(2_500_000n); // 25 bps of 1000 USDC
    expect(net).toBe(1000_000_000n - 2_500_000n);
  });
});

describe('decompose respects MAX_NOTES_PER_MINT for spends', () => {
  test('decompose caps at 64 outputs', () => {
    // whole representable range fits the 64-note mint budget (PRD 5.3)
    expect(decompose(1, maxAmount(1)).length).toBeLessThanOrEqual(64);
    expect(decompose(2, maxAmount(2)).length).toBeLessThanOrEqual(64);
    // above the ceiling there is no decomposition — must reject, not loop
    expect(() => decompose(1, 10n ** 18n)).toThrow('BatchTooLarge');
  });
});
