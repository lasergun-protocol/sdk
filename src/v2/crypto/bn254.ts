/**
 * BN254 (alt_bn128) G1 point arithmetic for the LaserGun v2 client.
 * Mirrors contracts/src/lib/Points.sol: 64-byte x‖y encoding, P/N domain,
 * canonical generator (1, 2). Scalars live in Z_n.
 */
import { keccak256, toBigInt, toBeHex } from 'ethers';

export const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
export const N = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const GX = 1n;
export const GY = 2n;

export interface Point {
  x: bigint;
  y: bigint; // 0n/0n encodes the point at infinity
}

export const INFINITY: Point = { x: 0n, y: 0n };

export function isOnCurve(x: bigint, y: bigint): boolean {
  if (x >= P || y >= P) return false;
  if (x === 0n && y === 0n) return false;
  return (y * y) % P === (((x * x) % P) * x + 3n) % P;
}

export function isValid(pt: Point): boolean {
  return isOnCurve(pt.x, pt.y);
}

function mod(v: bigint, m: bigint): bigint {
  const r = v % m;
  return r >= 0n ? r : r + m;
}

export function powMod(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function modInv(a: bigint, m: bigint): bigint {
  return powMod(a, m - 2n, m); // m is prime
}

/** Affine addition (short Weierstrass y² = x³ + 3). */
export function ecAdd(p1: Point, p2: Point): Point {
  if (p1.x === 0n && p1.y === 0n) return p2;
  if (p2.x === 0n && p2.y === 0n) return p1;
  const [x1, y1, x2, y2] = [p1.x, p1.y, p2.x, p2.y];
  if (x1 === x2) {
    if ((y1 + y2) % P === 0n) return INFINITY;
    return ecDouble(p1);
  }
  const lam = mod((y2 - y1) * modInv(mod(x2 - x1, P), P), P);
  const x3 = mod(lam * lam - x1 - x2, P);
  const y3 = mod(lam * (x1 - x3) - y1, P);
  return { x: x3, y: y3 };
}

export function ecDouble(p: Point): Point {
  if (p.x === 0n && p.y === 0n) return INFINITY;
  if (p.y === 0n) return INFINITY;
  const lam = mod(((3n * p.x) % P) * p.x % P * modInv((2n * p.y) % P, P), P);
  const x3 = mod(lam * lam - 2n * p.x, P);
  const y3 = mod(lam * (p.x - x3) - p.y, P);
  return { x: x3, y: y3 };
}

/** Scalar multiplication k·pt, k taken mod n. */
export function ecMul(k: bigint, pt: Point): Point {
  const scalar = mod(k, N);
  if (scalar === 0n || (pt.x === 0n && pt.y === 0n)) return INFINITY;
  let result = INFINITY;
  let addend: Point = pt;
  let s = scalar;
  while (s > 0n) {
    if (s & 1n) result = ecAdd(result, addend);
    addend = ecDouble(addend);
    s >>= 1n;
  }
  return result;
}

export function mulG(k: bigint): Point {
  return ecMul(k, { x: GX, y: GY });
}

// ── encoding: 64 bytes, 32-byte big-endian per coordinate ───────────

export function toWord(v: number | bigint): Uint8Array {
  const h = toBeHex(BigInt(v), 32);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/** Concatenate byte arrays (ethers concat returns string; this keeps bytes). */
export function cat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function encode(pt: Point): Uint8Array {
  return cat(toWord(pt.x), toWord(pt.y));
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function decodeUnchecked(raw: Uint8Array | string): Point {
  const bytes = typeof raw === 'string' ? hexToBytes(raw) : raw;
  if (bytes.length !== 64) throw new Error('InvalidPoint: bad length');
  return { x: toBigInt(bytes.slice(0, 32)), y: toBigInt(bytes.slice(32, 64)) };
}

export function decode(raw: Uint8Array | string): Point {
  const bytes = typeof raw === 'string' ? hexToBytes(raw) : raw;
  if (bytes.length !== 64) throw new Error('InvalidPoint: bad length');
  const x = toBigInt(bytes.slice(0, 32));
  const y = toBigInt(bytes.slice(32, 64));
  if (!isOnCurve(x, y)) throw new Error('InvalidPoint');
  return { x, y };
}

export function encodeHp(pt: Point, counter: number): Uint8Array {
  return cat(toWord(pt.x), toWord(pt.y), new Uint8Array([counter & 0xff]));
}

/** keccak256 over concatenated parts → bigint. */
export function hashBn(...parts: (Uint8Array | string)[]): bigint {
  return toBigInt(keccak256(hexOf(cat(...parts.map(asBytes)))));
}

export function modN(v: bigint): bigint {
  return mod(v, N);
}

export function keccakN(...parts: (Uint8Array | string)[]): bigint {
  return toBigInt(keccak256(hexOf(cat(...parts.map(asBytes))))) % N;
}

function asBytes(v: Uint8Array | string): Uint8Array {
  return typeof v === 'string' ? hexToBytes(v) : v;
}

export function hexOf(b: Uint8Array): string {
  let s = '0x';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
