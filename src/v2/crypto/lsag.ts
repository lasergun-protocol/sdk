/**
 * LSAG signatures, hp hash-to-point, key images, Schnorr permit and the
 * spend message hash. Exact mirror of contracts/src/lib/LSAG.sol,
 * contracts/src/LaserGunCore.sol (messageHash, _verifySchnorr) and the
 * reference signer test/lib/SolLSAG.sol (appendix Б of the PRD).
 */
import { hexOf,
  Point, P, N, ecAdd, ecMul, mulG, encode, encodeHp, decodeUnchecked,
  isOnCurve, isValid, modN, keccakN, hashBn, INFINITY,
  toWord, cat } from './bn254.js';

// ── hash-to-point, try-and-increment (6.3) ──────────────────────────

export interface HpPoint {
  hp65: Uint8Array; // x‖y‖counter
  point: Point;
  counter: number;
}

export function hpTryIncrement(yx: bigint, yy: bigint): HpPoint {
  for (let c = 0; c < 256; c++) {
    const h = hashBn(toWord(yx), toWord(yy), new Uint8Array([c]));
    const x = h % P;
    const rhs = (((x * x) % P) * x + 3n) % P;
    const y0 = powMod(rhs, (P + 1n) / 4n, P);
    if ((y0 * y0) % P === rhs) {
      const mirror = P - y0;
      const y = mirror > y0 ? mirror : y0; // canonical (larger) root
      const point = { x, y };
      return { hp65: encodeHp(point, c), point, counter: c };
    }
  }
  throw new Error('hp derivation failed');
}

function powMod(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = base % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

export function hpForRing(ring: Uint8Array[]): HpPoint[] {
  return ring.map((member) => {
    const pt = decodeUnchecked(member);
    return hpTryIncrement(pt.x, pt.y);
  });
}

/** On-chain equivalent of LSAG.hpDerivationOk. */
export function hpDerivationOk(yBytes: Uint8Array, counter: number, hx: bigint, hy: bigint): boolean {
  if (yBytes.length !== 64) return false;
  if (hx >= P || hy >= P) return false;
  if (hx === 0n && hy === 0n) return false;
  const h = hashBn(yBytes, new Uint8Array([counter & 0xff]));
  if (h % P !== hx) return false;
  if (!isOnCurve(hx, hy)) return false;
  const mirror = P - hy;
  return !(mirror > hy);
}

// ── key image ───────────────────────────────────────────────────────

/** I = y · Hp(X_real). */
export function keyImage(noteSecret: bigint, commitment: Uint8Array): Uint8Array {
  const pt = decodeUnchecked(commitment);
  const hp = hpTryIncrement(pt.x, pt.y);
  const i = ecMul(noteSecret, hp.point);
  return encode(i);
}


// ── spend message hash (11.2) ───────────────────────────────────────

export interface SpendOutputs {
  change?: ChangeLike;
  env?: EnvelopeLike;
  payee?: PayeeLike;
}

export interface ChangeLike { di: number[]; E: Uint8Array[]; X: Uint8Array[] }
export interface PayeeLike { di: number[]; E: Uint8Array[]; X: Uint8Array[] }
export interface EnvelopeLike {
  id: string; assetId: number; di: number[]; expiry: bigint;
  permitRequired: boolean;
  E_r: Uint8Array; X_r: Uint8Array; E_s: Uint8Array; X_s: Uint8Array;
}

/**
 * keccak256("LG2-w" ‖ assetId ‖ di ‖ recipient ‖ chainid ‖ H(change) ‖ H(env) ‖ H(payee)).
 * The block hashes are keccak256(abi.encode(struct)) of the non-empty blocks
 * (empty blocks contribute bytes32(0)), matching LaserGunCore.messageHash.
 */
export function messageHash(
  assetId: number, di: number, recipient: string, chainId: bigint, outputs: SpendOutputs,
): Uint8Array {
  const hc = outputs.change ? abiEncodeHashChange(outputs.change) : ZERO32;
  const he = outputs.env ? abiEncodeHashEnvelope(outputs.env) : ZERO32;
  const hpp = outputs.payee ? abiEncodeHashPayee(outputs.payee) : ZERO32;
  return toWord(
    hashBn(
    new Uint8Array([0x4c, 0x47, 0x32, 0x2d, 0x77]), // "LG2-w"
    toWord(assetId),
    toWord(di),
    addressBytes(recipient),
    toWord(chainId),
    hc, he, hpp,
    ),
  );
}

const ZERO32 = new Uint8Array(32);

function addressBytes(addr: string): Uint8Array {
  const h = addr.toLowerCase().replace(/^0x/, '').padStart(40, '0');
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Minimal Solidity tuple encoders for Change {uint256[], bytes[], bytes[]},
// Payee (same layout) and Envelope. Head/tail dynamic encoding per spec.

function encUintArr(values: number[] | bigint[]): Uint8Array {
  // канонический tail массива в тюпле: длина, затем данные (без offset-слота)
  const words = values.map((v) => toWord(BigInt(v)));
  return cat(toWord(values.length), ...words);
}

function encBytesArr(items: Uint8Array[]): Uint8Array {
  // tail массива: [len][offsets][items]; offsets измеряются от конца
  // length-слота (первый off = n*32 — по ABI-спеке для динамических массивов)
  const offsets: Uint8Array[] = [];
  let acc = items.length * 32;
  for (const it of items) {
    offsets.push(toWord(acc));
    acc += 32 + it.length + ((32 - (it.length % 32)) % 32);
  }
  // bytes[] encoding: length, item offsets, then items (tail без offset-слота)
  const out: Uint8Array[] = [];
  out.push(toWord(items.length));
  for (const off of offsets) out.push(off);
  for (const it of items) {
    out.push(toWord(it.length));
    const pad = (32 - (it.length % 32)) % 32;
    out.push(it);
    if (pad) out.push(new Uint8Array(pad));
  }
  return cat(...out);
}

function abiEncodeHashChange(c: ChangeLike): Uint8Array {
  // abi.encode((uint256[],bytes[],bytes[])) → tuple head with 3 offsets
  const a = encUintArr(c.di);
  const b = encBytesArr(c.E);
  const d = encBytesArr(c.X);
  return hashTuple([a, b, d]);
}

function abiEncodeHashPayee(p: PayeeLike): Uint8Array {
  return hashTuple([encUintArr(p.di), encBytesArr(p.E), encBytesArr(p.X)]);
}

function abiEncodeHashEnvelope(e: EnvelopeLike): Uint8Array {
  // (bytes32, uint256, uint256[], uint256, bool, bytes, bytes, bytes, bytes)
  const statics: Uint8Array[] = [
    wordOf32(e.id),
    toWord(e.assetId),
  ];
  const dynDi = encUintArr(e.di);
  const dynExpiry = toWord(e.expiry);
  const dynPermit = toWord(e.permitRequired ? 1 : 0);
  const dynEr = encBytesSingle(e.E_r);
  const dynXr = encBytesSingle(e.X_r);
  const dynEs = encBytesSingle(e.E_s);
  const dynXs = encBytesSingle(e.X_s);
  const dyns = [dynDi, dynEr, dynXr, dynEs, dynXs];
  // head: 9 slots; dynamic slots carry offsets relative to the block start
  const headWords = 9;
  let tailSize = dyns.reduce((s, d) => s + d.length, 0);
  void tailSize;
  const offsets: Uint8Array[] = [];
  let acc = headWords * 32;
  // order of dynamics in tail: di(2), expiry(3) static, permit(4) static, Er(5), Xr(6), Es(7), Xs(8)
  const dynSlots = [2, 5, 6, 7, 8];
  const offsetMap = new Map<number, number>();
  for (const slot of dynSlots) {
    offsetMap.set(slot, acc);
    const d = dyns[dynSlots.indexOf(slot)];
    acc += d.length;
  }
  for (let slot = 0; slot < headWords; slot++) {
    if (offsetMap.has(slot)) offsets.push(toWord(offsetMap.get(slot)!));
  }
  const head: Uint8Array[] = [
    ...statics,
    offsets[0], // slot 2: di
    dynExpiry, // slot 3
    dynPermit, // slot 4
    offsets[1], offsets[2], offsets[3], offsets[4],
  ];
  return hashTupleSafe(cat(toWord(0x20), ...head, ...dyns));
}

function hashTupleSafe(data: Uint8Array): Uint8Array {
  return toWord(hashBn(data));
}

function wordOf32(hexish: string): Uint8Array {
  const h = hexish.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function encBytesSingle(b: Uint8Array): Uint8Array {
  const pad = (32 - (b.length % 32)) % 32;
  return cat(toWord(b.length), b, new Uint8Array(pad));
}

function hashTuple(parts: Uint8Array[]): Uint8Array {
  // abi.encode(динамический тюпл): [0x20-offset] + head(offsets) + tails;
  // offsets измеряются от начала тюпла (0x20-слот вне тюпла)
  let acc = parts.length * 32;
  const offsets: Uint8Array[] = [];
  for (const p of parts) {
    offsets.push(toWord(acc));
    acc += p.length;
  }
  return toWord(hashBn(toWord(0x20), cat(...offsets, ...parts)));
}

// ── LSAG sign/verify (appendix Б) ───────────────────────────────────

export interface LsagSignature {
  I: Uint8Array; // key image, 64 bytes
  c1: string; // 32-byte hex
  s: bigint[];
}

/**
 * One-pass LSAG signing, byte-exact with test/lib/SolLSAG.sol:
 * alpha  = H(m‖0x5eed) in [1, n-1]
 * s_k    = H(m‖k‖0x51) in [1, n-1] for decoys
 * c_{π+1} = H(m‖α·G‖α·Hp(Y_π)); chain closes at index π.
 */
export function lsagSign(
  mHash: Uint8Array, ring: Uint8Array[], pi: number, secret: bigint,
  hpPrecomputed?: HpPoint[],
): LsagSignature {
  const n = ring.length;
  if (pi < 0 || pi >= n) throw new Error('pi out of range');
  const hp = hpPrecomputed ?? hpForRing(ring);

  const realHp = hp[pi];
  const I = ecMul(secret, realHp.point);
  const Ib = encode(I);

  // Solidity mirror: scalars are drawn as (h mod (N-1)) + 1 ∈ [1, N-1]
  const alpha = (hashBn(mHash, toWord(0x5eed)) % (N - 1n)) + 1n;
  const s: bigint[] = new Array(n).fill(0n);
  for (let k = 0; k < n; k++) {
    if (k !== pi) s[k] = (hashBn(mHash, toWord(k), toWord(0x51)) % (N - 1n)) + 1n;
  }

  // c_{π+1} = H(m, α·G, α·Hp(Y_π))
  const ag = mulG(alpha);
  const ah = ecMul(alpha, realHp.point);
  let cNext = keccakN(mHash, toWord(ag.x), toWord(ag.y), toWord(ah.x), toWord(ah.y));

  const cArr: bigint[] = new Array(n).fill(0n);
  for (let step = 1; step <= n; step++) {
    const j = (pi + step) % n;
    cArr[j] = cNext;
    if (j === pi) break;
    const yj = decodeUnchecked(ring[j]);
    const hpj = hp[j];
    const sg = mulG(s[j]);
    const cy = ecMul(cNext, yj);
    const L = ecAdd(sg, cy);
    const sh = ecMul(s[j], hpj.point);
    const ci = ecMul(cNext, I);
    const R = ecAdd(sh, ci);
    cNext = keccakN(mHash, toWord(L.x), toWord(L.y), toWord(R.x), toWord(R.y));
  }

  s[pi] = modN(alpha + N - ((cArr[pi] * secret) % N));
  return { I: Ib, c1: hexOf(toWord(cArr[0])), s };
}

/** Byte-exact mirror of LSAG.verify. */
export function lsagVerify(
  mHash: Uint8Array, ring: Uint8Array[], hp: HpPoint[], I: Uint8Array,
  c1: string, s: bigint[],
): boolean {
  const n = ring.length;
  if (s.length !== n || hp.length !== n) return false;
  const cv = BigInt(c1);
  if (cv >= N) return false;
  const ip = decodeUnchecked(I);
  if (!isValid(ip)) return false;
  for (let j = 0; j < n; j++) if (s[j] >= N) return false;

  let cx = cv;
  for (let j = 0; j < n; j++) {
    const yj = decodeUnchecked(ring[j]);
    const sg = mulG(s[j]);
    const cy = ecMul(cx, yj);
    const L = ecAdd(sg, cy);
    const sh = ecMul(s[j], hp[j].point);
    const ci = ecMul(cx, ip);
    const R = ecAdd(sh, ci);
    cx = keccakN(mHash, toWord(L.x), toWord(L.y), toWord(R.x), toWord(R.y));
  }
  return cx === cv;
}

// ── Schnorr permit (9.1): c = H("LG2-p"‖X_s‖R‖id), s·G == R + c·X_s ──

export function schnorrSign(secret: bigint, id: Uint8Array): { R: Uint8Array; s: bigint; sig: Uint8Array } {
  const Xs = mulG(secret);
  const k = keccakN(encode(Xs), id, toWord(0x726e)); // fresh k from key+id
  const R = mulG(k);
  const c = keccakN(
    new Uint8Array([0x4c, 0x47, 0x32, 0x2d, 0x70]), // "LG2-p"
    toWord(Xs.x), toWord(Xs.y),
    toWord(R.x), toWord(R.y),
    id,
  );
  const s = modN(k + c * secret);
  const sig = cat(encode(R), toWord(s));
  return { R: encode(R), s, sig };
}

export function schnorrVerify(pubXs: Point, id: Uint8Array, R: Point, s: bigint): boolean {
  const c = keccakN(
    new Uint8Array([0x4c, 0x47, 0x32, 0x2d, 0x70]),
    toWord(pubXs.x), toWord(pubXs.y),
    toWord(R.x), toWord(R.y),
    id,
  );
  const lhs = mulG(s);
  const rhs = ecAdd(R, ecMul(c, pubXs));
  return lhs.x === rhs.x && lhs.y === rhs.y;
}

export { INFINITY };
