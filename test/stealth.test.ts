/**
 * Stealth layer: derivation/recovery round-trips per PRD 6.1/6.2 —
 * the same invariants checked in contracts fuzz (StealthFuzz.t.sol).
 */
import {
  deriveNoteForRecipient, tryRecoverNote, randomScalar,
  envelopeNoteSecret, envelopeNotePoint,
} from '../src/v2/crypto/stealth';
import { deriveKeys } from '../src/v2/crypto/keys';
import { encode, mulG, N } from '../src/v2/crypto/bn254';
import type { Wallet } from 'ethers';

describe('Stealth notes (6.1, 6.2)', () => {
  test('recipient recovers the note the sender derived for their meta-address', async () => {
    const { Wallet } = await import('ethers');
    const strangerWallet = new Wallet('0x'.padEnd(66, '1')) as Wallet;
    const recipient = new Wallet('0x'.padEnd(66, '2')) as Wallet;
    const rk = await deriveKeys(recipient);
    const e = randomScalar();
    const note = deriveNoteForRecipient(rk.metaAddress, rk.spendSecret, 5, e);
    // sender-side consistency: E == e·G, X == y·G
    expect(Buffer.from(note.E).toString('hex')).toBe(Buffer.from(encode(mulG(e))).toString('hex'));
    const back = tryRecoverNote(rk.viewSecret, rk.spendSecret, note.E, note.X);
    expect(back.owned).toBe(true);
    expect(back.y).toBe(note.y);
    // random third party cannot recover
    const stranger = await deriveKeys(strangerWallet);
    const foreign = tryRecoverNote(
      stranger.viewSecret, stranger.spendSecret, note.E, note.X,
    );
    expect(foreign.owned).toBe(false);
  });

  test('X = (H(v·E) + p)·G over 200 random iterations', () => {
    for (let i = 0; i < 200; i++) {
      const v = randomScalar();
      const p = randomScalar();
      const e = randomScalar();
      const meta = { V: mulG(v), P: mulG(p) };
      const note = deriveNoteForRecipient(meta, p, 3, e);
      const back = tryRecoverNote(v, p, note.E, note.X);
      expect(back.owned).toBe(true);
      expect(back.y).toBe(note.y);
    }
  });

  test('envelope branch: m notes derive deterministically from y_r and id', () => {
    const y_r = randomScalar();
    const id = '0x' + Buffer.from(new Uint8Array(32).map((_, i) => (i * 7) % 256)).toString('hex');
    const seen = new Set<string>();
    for (let j = 0; j < 8; j++) {
      const yj = envelopeNoteSecret(y_r, id, j);
      const Xj = envelopeNotePoint(encode(mulG(y_r)), id, j);
      expect(mulG(yj).x).toBe(Xj.x);
      expect(mulG(yj).y).toBe(Xj.y);
      expect(seen.has(yj.toString())).toBe(false);
      seen.add(yj.toString());
    }
  });
});
