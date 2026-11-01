/**
 * Note-level helpers: key image / nullifier and spend planning
 * (ring assembly per 6.6, output conservation per 6.7, gate discipline).
 */
import { encode, mulG, decodeUnchecked, Point, hashBn, N, ecMul, ecAdd } from '../crypto/bn254.js';
import { keyImage as computeKeyImage } from '../crypto/lsag.js';
import {
  denomOf, indexOf, sumOf, feeTransfer, feeOut, feeIn, decompose, minDenom, GRID,
} from '../crypto/grid.js';
import { keccak256, hexlify } from 'ethers';
import { deriveNoteForRecipient, MetaAddress } from '../crypto/stealth.js';
import { ChangeLike, PayeeLike, EnvelopeLike, messageHash, hpForRing, lsagSign } from '../crypto/lsag.js';

export { computeKeyImage };

/** nullifier = keccak256(I) — the on-chain double-spend key. */
export function nullifierOfKey(I: Uint8Array): string {
  return keccak256(hexlify(I));
}
export const MIN_RING = 16;
export const MAX_RING = 64;
export const MAX_NOTES_PER_MINT = 64;

export interface SpendPlan {
  assetId: number;
  di: number;
  recipient: string; // core address (change/env), zero (payee) or payout receiver
  ring: Uint8Array[];
  outputs: { change?: ChangeLike; env?: EnvelopeLike; payee?: PayeeLike };
}

export interface RingMember { X: Uint8Array }

/**
 * Decoy selection (6.6): uniform without replacement from the live registry
 * of the (assetId, di) pair, excluding the real member. The caller supplies
 * the live commitment multiset (from the scanner registry).
 */
export function pickRing(
  liveCommitments: Uint8Array[], realX: Uint8Array, ringSize: number,
): Uint8Array[] {
  if (ringSize < MIN_RING || ringSize > MAX_RING) throw new Error('RingTooSmall');
  const pool = liveCommitments.filter(
    (c) => !(c.length === realX.length && c.every((b, i) => b === realX[i])),
  );
  if (pool.length < ringSize - 1) throw new Error('RingTooSmall: insufficient decoys');
  // deterministic Fisher-Yates on a copy (entropy provided by caller ordering)
  const out = pool.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  const ring = [realX, ...out.slice(0, ringSize - 1)];
  // shuffle so the real index is not position 0
  for (let i = ring.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ring[i], ring[j]] = [ring[j], ring[i]];
  }
  return ring;
}

export interface StealthBatch { di: number[]; E: Uint8Array[]; X: Uint8Array[] }

/** Build a change batch minted to the sender's own fresh stealth point. */
export function buildChangeBatch(
  assetId: number, amount: bigint, viewSecret: bigint, spendSecret: bigint,
): StealthBatch {
  const dis = decompose(assetId, amount);
  const batch: StealthBatch = { di: dis, E: [], X: [] };
  for (const di of dis) {
    const note = deriveNoteForRecipient(
      { V: mulG(viewSecret), P: mulG(spendSecret) }, spendSecret, di,
    );
    batch.E.push(note.E);
    batch.X.push(note.X);
  }
  return batch;
}

/** Build a payee batch for a recipient meta-address (stelth delivery). */
export function buildPayeeBatch(
  assetId: number, amount: bigint, meta: MetaAddress,
): StealthBatch {
  const dis = decompose(assetId, amount);
  const batch: StealthBatch = { di: dis, E: [], X: [] };
  const freshP = deriveSpendSecret(meta);
  for (const di of dis) {
    const note = deriveNoteForRecipient(meta, freshP, di);
    batch.E.push(note.E);
    batch.X.push(note.X);
  }
  return batch;
}

/**
 * The payee spend secret is known only to the recipient; the sender derives
 * notes with the recipient's view key V and a random per-note spend offset.
 * In v2 notes are single-key: y = H(v·E) + p where p is the recipient's.
 * For delivery the sender cannot know p; the PRD resolves this by having the
 * sender use the recipient's published spend point P: X = H(e·V)·G + P.
 */
function deriveSpendSecret(_meta: MetaAddress): bigint {
  return 0n; // unused: buildPayeeBatchTo handles the X = s·G + P form
}

/** Sender-form delivery notes: X = H(e·V)·G + P (6.1, sender derivation). */
export function buildPayeeBatchTo(
  assetId: number, amount: bigint, meta: MetaAddress,
): StealthBatch {
  const dis = decompose(assetId, amount);
  // fresh array: pushing into `dis` while iterating it would loop forever
  const batch: StealthBatch = { di: [], E: [], X: [] };
  for (const di of dis) {
    const e = randomScalarLocal();
    const E = mulG(e);
    const s = hash64(encode(ecMul(e, meta.V)));
    const X = ecAdd(mulG(s), meta.P);
    batch.di.push(di);
    batch.E.push(encode(E));
    batch.X.push(encode(X));
  }
  return batch;
}

function randomScalarLocal(): bigint {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return (hashBn(buf) % (N - 1n)) + 1n;
}

function hash64(b: Uint8Array): bigint {
  return hashBn(b);
}

export interface SignedSpend {
  mHash: string;
  I: Uint8Array;
  c1: string;
  s: bigint[];
  hp: Uint8Array[];
}

/** Compose and sign the LSAG over the spend message (6.3). */
export function signSpend(
  plan: {
    assetId: number; di: number; recipient: string; chainId: bigint;
    ring: Uint8Array[]; outputs: { change?: ChangeLike; env?: EnvelopeLike; payee?: PayeeLike };
  },
  realIndex: number,
  noteSecret: bigint,
): SignedSpend {
  const m = messageHash(
    plan.assetId, plan.di, plan.recipient, plan.chainId, plan.outputs,
  );
  const hp = hpForRing(plan.ring);
  const sig = lsagSign(m, plan.ring, realIndex, noteSecret, hp);
  return {
    mHash: hexlify(m),
    I: sig.I,
    c1: sig.c1,
    s: sig.s,
    hp: hp.map((h) => h.hp65),
  };
}

// ── conservation arithmetic (6.7) ───────────────────────────────────

export function spendConservationTransfer(
  assetId: number, di: number, changeDi: number[], envDi: number[],
): { ok: boolean; fee: bigint } {
  const d = denomOf(assetId, di);
  const fee = feeTransfer(assetId, d);
  return {
    ok: sumOf(assetId, changeDi) + sumOf(assetId, envDi) + fee === d,
    fee,
  };
}

export function spendConservationPayee(
  assetId: number, di: number, payeeDi: number[],
): { ok: boolean; fee: bigint } {
  const d = denomOf(assetId, di);
  const fee = feeTransfer(assetId, d);
  return { ok: sumOf(assetId, payeeDi) + fee === d, fee };
}

export function cashoutAmount(assetId: number, di: number): { gross: bigint; fee: bigint; net: bigint } {
  const gross = denomOf(assetId, di);
  const fee = feeOut(gross);
  return { gross, fee, net: gross - fee };
}

export { denomOf, indexOf, sumOf, feeTransfer, feeOut, feeIn, decompose, minDenom, GRID };
export { decodeUnchecked };
export type { Point };
