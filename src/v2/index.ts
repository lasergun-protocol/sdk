/**
 * LaserGun v2 SDK — public surface.
 * Mirrors contracts/src (PRD v2, раздел 6, 9–11): BN254 points, LSAG,
 * denomination grid {1,3,5}×10^k, stealth notes, envelopes, executor flows.
 */
export * from './crypto/bn254.js';
export * from './crypto/grid.js';
export {
  hpTryIncrement, hpForRing, hpDerivationOk, keyImage, lsagSign, lsagVerify,
  messageHash, schnorrSign, schnorrVerify,
} from './crypto/lsag.js';
export type { HpPoint, LsagSignature, ChangeLike, PayeeLike, EnvelopeLike } from './crypto/lsag.js';
export {
  deriveNoteForRecipient, tryRecoverNote, envelopeNoteHash, envelopeNotePoint,
  envelopeNoteSecret, randomScalar,
} from './crypto/stealth.js';
export type { MetaAddress, StealthNote } from './crypto/stealth.js';
export { deriveKeys } from './crypto/keys.js';
export type { LaserGunKeys } from './crypto/keys.js';

export * from './core/abi.js';
export {
  LaserGunV2, NETWORKS, nullifierOfKey, pickRing, buildChangeBatch,
  buildPayeeBatchTo, signSpend, cashoutAmount, scanOwnedNotes,
} from './index-impl.js';
export type {
  LaserGunV2Config, EnterOptions, EnterResult, SpendOptions, SpendResult,
  EnvelopeView, OwnedNote, ScanResult, RingMember, SignedSpend, StealthBatch,
} from './index-impl.js';
export type { SpendOutputs } from './crypto/lsag.js';
