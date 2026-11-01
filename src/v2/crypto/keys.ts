/**
 * Client keys: deterministic derivation of the meta-address pair
 * (V = v·G, P = p·G) from a signer message per PRD 6.1, plus note store.
 */
import { Wallet, hashMessage, toUtf8Bytes } from 'ethers';
import { mulG, encode, Point, hashBn, N } from './bn254.js';
import { MetaAddress, randomScalar } from './stealth.js';

export interface LaserGunKeys {
  viewSecret: bigint; // v
  spendSecret: bigint; // p
  V: Point;
  P: Point;
  metaAddress: MetaAddress;
  address: string;
}

/**
 * Deterministic secrets from an EOA signature of `message` (freshness per
 * wallet, no on-chain registration — v2 has no registerPublicKey).
 */
export async function deriveKeys(
  signer: Wallet | { signMessage(m: string): Promise<string>; getAddress(): Promise<string> },
  message = 'LaserGun v2 key derivation',
): Promise<LaserGunKeys> {
  const address = await signer.getAddress();
  const sig = await signer.signMessage(message);
  const digest = hashMessage(sig); // keccak of the padded EIP-191 message
  const seed = toUtf8Bytes(digest);
  const v = keccakScalar(seed, 0);
  const p = keccakScalar(seed, 1);
  const V = mulG(v);
  const Pp = mulG(p);
  return {
    viewSecret: v,
    spendSecret: p,
    V,
    P: Pp,
    metaAddress: { V, P: Pp },
    address,
  };
}

function keccakScalar(seed: Uint8Array, domain: number): bigint {
  // FNV domain separation over the seed bytes, then keccak in bn254
  let h = 2166136261;
  const bytes = new Uint8Array(seed.length + 4);
  bytes.set(seed, 0);
  new DataView(bytes.buffer).setUint32(seed.length, domain);
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619);
  }
  const tagged = new Uint8Array(bytes.length + 4);
  tagged.set(bytes, 0);
  new DataView(tagged.buffer).setUint32(bytes.length, h >>> 0);
  let x = hashBn(tagged) % (N - 1n);
  x += 1n;
  return x;
}

export { encode, randomScalar };
