/**
 * Stealth note derivation (6.1) and envelope note multiplication (9.x).
 * Sender:  E = e·G, s = H(e·V), y = (s + p) mod n, X = y·G.
 * Scanner: s = H(v·E), y = (s + p) mod n, checks X == y·G.
 * Envelope claim mint: X_j = X_r + h_j·G, y_j = y_r + h_j (refund: X_s / y_s).
 */

import {
  Point, N, ecAdd, ecMul, mulG, encode, decodeUnchecked, modN, hashBn, keccakN,
  toWord } from './bn254.js';

export interface MetaAddress {
  V: Point; // view key public v·G
  P: Point; // spend key public p·G
}

export interface StealthNote {
  E: Uint8Array; // ephemeral point, 64 bytes
  X: Uint8Array; // commitment y·G, 64 bytes
  y: bigint; // note secret (owner only)
  di: number; // denomination index
}

/** Sender-side note derivation for a recipient meta-address. */
export function deriveNoteForRecipient(
  meta: MetaAddress, spendSecretP: bigint, di: number, ephSecret?: bigint,
): StealthNote {
  const e = ephSecret ?? randomScalar();
  const E = mulG(e);
  const s = hashBn(encode(ecMul(e, meta.V))); // H(e·V)
  const y = modN(s + spendSecretP);
  const X = mulG(y);
  return { E: encode(E), X: encode(X), y, di };
}

/** Scanner-side ownership check and secret recovery. */
export function tryRecoverNote(
  viewSecret: bigint, spendSecretP: bigint, E: Uint8Array, X: Uint8Array,
): { owned: boolean; y: bigint } {
  const Ep = decodeUnchecked(E);
  const s = hashBn(encode(ecMul(viewSecret, Ep)));
  const y = modN(s + spendSecretP);
  const yG = mulG(y);
  const Xp = decodeUnchecked(X);
  const owned = yG.x === Xp.x && yG.y === Xp.y;
  return { owned, y: owned ? y : 0n };
}

/** Envelope note index hash: h_j = H("LG2-e" ‖ id ‖ uint256(j)) mod n. */
export function envelopeNoteHash(id: string, j: number): bigint {
  return keccakN(new Uint8Array([0x4c, 0x47, 0x32, 0x2d, 0x65]), bytesOf32(id), toWord(j));
}

/** X_j = X_base + h_j·G — the public mint point of envelope note j. */
export function envelopeNotePoint(XBase: Uint8Array, id: string, j: number): Point {
  const h = envelopeNoteHash(id, j);
  return ecAdd(decodeUnchecked(XBase), mulG(h));
}

/** y_j = y_base + h_j mod n — the secret of envelope note j. */
export function envelopeNoteSecret(yBase: bigint, id: string, j: number): bigint {
  return modN(yBase + envelopeNoteHash(id, j));
}

/** Fresh random scalar in [1, n-1] (crypto.getRandomValues, 32 bytes). */
export function randomScalar(): bigint {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let v = hashBn(buf) % (N - 1n);
  return v + 1n;
}

function bytesOf32(v: string): Uint8Array {
  const h = v.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export { encode, decodeUnchecked, ecMul, mulG, ecAdd };
