/**
 * LaserGun v2 client. One class per wallet covering the full protocol
 * surface: enter (receiver deployment + EIP-3009/ETH), private spend with
 * change/stealth-delivery/cashout, envelopes (open/claim/refund), fee sweep
 * and the event-driven state rebuild.
 */
import { Contract, Provider, Signer, parseUnits, formatUnits } from 'ethers';
import { ASSETS, CORE_ABI, EXECUTOR_ABI, FACTORY_ABI, CORE as CORE_IFACE } from './abi.js';
import { LaserGunKeys, deriveKeys } from '../crypto/keys.js';
import {
  MetaAddress, envelopeNoteSecret, envelopeNotePoint,
} from '../crypto/stealth.js';
import { mulG, encode, decodeUnchecked, Point, N, hashBn } from '../crypto/bn254.js';
import { schnorrSign } from '../crypto/lsag.js';
import { deriveNoteForRecipient } from '../crypto/stealth.js';
import { denomOf, decompose, feeIn, feeTransfer, sumOf } from '../crypto/grid.js';
import type { OwnedNote } from './scanner.js';
import {
  MIN_RING, MAX_RING, pickRing, buildChangeBatch, buildPayeeBatchTo, signSpend,
  cashoutAmount, nullifierOfKey, computeKeyImage,
} from './notes.js';

export { computeKeyImage };

// ── network defaults (chain 15.1: Base primary, Base Sepolia rehearsal) ──
export const NETWORKS = {
  base: { chainId: 8453, name: 'Base' },
  'base-sepolia': { chainId: 84532, name: 'Base Sepolia' },
} as const;

export interface LaserGunV2Config {
  core: string;
  executor?: string; // resolved from core.executor() when omitted
  factory?: string; // resolved from core.factory() when omitted
  provider: Provider;
  signer: Signer;
  /** USDC token address (assetId=1). WETH comes from the factory config. */
  usdc: string;
  weth: string;
  /** Aave v3 Pool for reference/display paths. */
  pool?: string;
  /** Receiver creation code (loaded from deployment artifacts, 11.1). */
  receiverTemplate?: string;
  /** OutputReceiver creation code for payout self-registration. */
  outputReceiverTemplate?: string;
}

export interface EnterOptions {
  assetId: 1 | 2;
  /** Total deposit S in minimal units (feeIn is taken on S). */
  amount: bigint;
  /** Deploy receiver counterfactually; default true for USDC relay flow. */
  maxNotes?: number;
}

export interface EnterResult {
  receiver: string;
  salt: string;
  depositAmount: bigint; // S
  mintedNotes: number;
  deposited: bigint;
  txHash?: string;
}

export interface SpendOptions {
  assetId: 1 | 2;
  /** The owned note to spend. */
  note: { X: string; y: string; di: number };
  /** Live commitments of the pair from the local registry (6.6). */
  liveCommitments?: string[];
  /** Полный реестр нот сканера: кольцо строится по своей паре (assetId, di). */
  liveNotes?: OwnedNote[];
  ringSize?: number;
  mode: 'change' | 'envelope' | 'stealth' | 'cashout';
  /** change mode: amount to keep as change (rest pays feeTransfer). */
  changeAmount?: bigint;
  /** envelope mode: parameters of the opened envelope. */
  envelope?: {
    amount: bigint; // Σ di of the envelope
    expiry: bigint;
    permitRequired: boolean;
    recipientMeta?: MetaAddress; // recipient's (V, P) — for cross-user sends
  };
  /** stealth mode: recipient meta-address. */
  payeeMeta?: MetaAddress;
  /** cashout mode: registered payout receiver. */
  payoutReceiver?: string;
}

export interface SpendResult {
  txHash: string;
  nullifier: string;
  ringSize: number;
  changeNotes?: Array<{ X: string; di: number }>;
  envId?: string;
  payoutTo?: string;
  amountOut?: bigint;
}

export interface EnvelopeView {
  id: string;
  assetId: number;
  di: number[];
  openAt: bigint;
  expiry: bigint;
  open: boolean;
  claimed: boolean;
  permitRequired: boolean;
}

export class LaserGunV2 {
  readonly cfg: LaserGunV2Config;
  keys: LaserGunKeys | null = null;
  private core: Contract;
  private factoryAddr = '';
  private executorAddr = '';

  constructor(cfg: LaserGunV2Config) {
    this.cfg = cfg;
    this.core = new Contract(cfg.core, CORE_ABI, cfg.signer);
  }

  /** Derive wallet keys deterministically and resolve the fixed links. */
  async initialize(derivationMessage = 'LaserGun v2 key derivation'): Promise<LaserGunKeys> {
    this.keys = await deriveKeys(this.cfg.signer, derivationMessage);
    this.factoryAddr = this.cfg.factory ?? (await this.core.factory());
    this.executorAddr = this.cfg.executor ?? (await this.core.executor());
    return this.keys;
  }

  metaAddress(): MetaAddress {
    if (!this.keys) throw new Error('not initialized');
    return { V: this.keys.V, P: this.keys.P };
  }

  metaAddressHex(): { V: string; P: string } {
    const m = this.metaAddress();
    return { V: '0x' + toHex64(m.V.x) + toHex64(m.V.y).slice(2), P: '0x' + toHex64(m.P.x) + toHex64(m.P.y).slice(2) };
  }

  // ── entry (8.x): counterfactual receiver, EIP-3009 or ETH ──────────

  /**
   * Plan an entry: decomposition, feeIn, receiver initcode params and the
   * CREATE2 address. Returns everything the relay needs to execute.
   */
  async planEntry(opts: EnterOptions): Promise<{
    depositAmount: bigint; netMint: bigint; di: number[];
    E: string[]; X: string[]; salt: string; predicted: string;
    notes: Array<{ X: string; y: string; di: number; denom: bigint }>;
  }> {
    if (!this.keys) throw new Error('not initialized');
    const assetId = opts.assetId;
    const maxNotes = opts.maxNotes ?? 64;
    const f = feeIn(assetId, opts.amount);
    const net = opts.amount - f;
    if (net <= 0n) throw new Error('AmountTooSmall');
    const dis = decompose(assetId, net, maxNotes);
    const notes: Array<{ X: string; y: string; di: number; denom: bigint }> = [];
    const E: string[] = [];
    const X: string[] = [];
    const meta = this.metaAddress();
    for (const di of dis) {
      // entry notes: stealth self-mint (6.1/6.2): y = H(e·V)+p, X = y·G
      const sn = deriveNoteForRecipient(meta, this.keys!.spendSecret, di);
      E.push('0x' + Array.from(sn.E, (b) => b.toString(16).padStart(2, '0')).join(''));
      X.push('0x' + Array.from(sn.X, (b) => b.toString(16).padStart(2, '0')).join(''));
      notes.push({
        X: X[X.length - 1], y: '0x' + sn.y.toString(16).padStart(64, '0'),
        di, denom: denomOf(assetId, di),
      });
    }
    const salt = toHex64(hashBn(cryptoRandBytes()) % (1n << 200n));
    const predicted = await this.predictReceiver(assetId, opts.amount, dis, E, X, salt);
    return { depositAmount: opts.amount, netMint: net, di: dis, E, X, salt, predicted, notes };
  }

  /** CREATE2 address of the entry receiver for the given mint parameters. */
  async predictReceiver(
    assetId: number, depositAmount: bigint, di: number[], E: string[], X: string[], salt: string,
  ): Promise<string> {
    const factory = new Contract(this.factoryAddr, FACTORY_ABI, this.cfg.provider);
    const initcode = this.receiverInitcode(assetId, depositAmount, di, E, X);
    return (await factory.predictAddress(salt, initcode)) as string;
  }

  /**
   * Full initcode of Receiver: template constructor args
   * (core, pool, asset, treasury, assetId, S, di, E, X).
   * The template runtime is a build artifact (11.1); the SDK takes the
   * factory-deployed template hash from the factory contract instead of
   * embedding bytecode, keeping CREATE2 binding with the on-chain factory.
   */
  receiverInitcode(
    assetId: number, depositAmount: bigint, di: number[], E: string[], X: string[],
  ): string {
    if (!this.cfg.receiverTemplate) throw new Error('ReceiverTemplateRequired');
    void depositAmount;
    return concatHex(this.cfg.receiverTemplate, this.encodeReceiverArgs(assetId, depositAmount, di, E, X));
  }

  /** Initcode of OutputReceiver(owner, usdc, weth) for payout registration. */
  outputReceiverInitcode(owner: string): string {
    if (!this.cfg.outputReceiverTemplate) throw new Error('OutputReceiverTemplateRequired');
    const ctor = new Interface([
      'constructor(address owner, address usdc, address weth)',
    ]);
    return concatHex(this.cfg.outputReceiverTemplate, ctor.encodeDeploy([owner, this.cfg.usdc, this.cfg.weth]));
  }

  /** Register the signer as a payout receiver (factory create2, payout=true). */
  async registerPayoutReceiver(saltSeed = cryptoRandBytes()): Promise<string> {
    const salt = '0x' + toHex64(hashBn(saltSeed) % (1n << 200n));
    const owner = await this.cfg.signer.getAddress();
    const initcode = this.outputReceiverInitcode(owner);
    const factory = new Contract(this.factoryAddr, FACTORY_ABI, this.cfg.signer);
    const tx = await factory.create2(salt, initcode, true);
    const rc = await tx.wait();
    let receiver = '';
    for (const l of rc.logs) {
      try {
        const p = factory.interface.parseLog(l);
        if (p && p.name === 'ReceiverDeployed') { receiver = p.args.receiver; break; }
      } catch { /* not our event */ }
    }
    return receiver;
  }

  /**
   * Constructor args of Receiver (8.2): (core, pool, asset, treasury,
   * assetId, S, di[], E[], X[]) — they join the full initcode and the
   * CREATE2 binding (INV-21).
   */
  encodeReceiverArgs(
    assetId: number, depositAmount: bigint, di: number[], E: string[], X: string[],
  ): string {
    const asset = assetId === 1 ? this.cfg.usdc : this.cfg.weth;
    if (!this.cfg.pool) throw new Error('PoolRequired');
    return RECEIVER_CTOR.encodeDeploy([
      this.cfg.core, this.cfg.pool, asset, TREASURY_PLACEHOLDER,
      assetId, depositAmount, di, E, X,
    ]);
  }

  /** Deploy + execute the entry through the receiver (USDC pull or ETH settle). */
  async enter(opts: EnterOptions & { fundTx?: string }): Promise<EnterResult> {
    const plan = await this.planEntry(opts);
    const factory = new Contract(this.factoryAddr, FACTORY_ABI, this.cfg.signer);
    void opts.fundTx;
    if (opts.assetId === 2) {
      // ETH: value goes to the predicted address before deployment (8.2).
      // Explicit nonces: fast-local-mining nodes break provider nonce caching.
      const n1 = await this.cfg.signer.getNonce();
      const tx = await this.cfg.signer.sendTransaction({
        to: plan.predicted, value: plan.depositAmount, nonce: n1,
      });
      await tx.wait();
    }
    const initcode = this.receiverInitcode(opts.assetId, plan.depositAmount, plan.di, plan.E, plan.X);
    const n2 = await this.cfg.signer.getNonce();
    const tx = await factory.create2(plan.salt, initcode, false, { nonce: n2 });
    const rc = await tx.wait();
    let settleHash = rc.hash;
    if (opts.assetId === 2) {
      // ETH-ветка: взнос уже на балансе приёмника — финализируем settle()
      const receiver = new Contract(plan.predicted, ['function settle() external'], this.cfg.signer);
      const n3 = await this.cfg.signer.getNonce();
      const st = await receiver.settle({ nonce: n3 });
      await st.wait();
      settleHash = tx.hash;
    }
    return {
      receiver: plan.predicted,
      salt: plan.salt,
      depositAmount: plan.depositAmount,
      mintedNotes: plan.di.length,
      deposited: plan.depositAmount,
      txHash: settleHash,
    };
  }

  /**
   * EIP-3009 signature for the USDC pull path (relay executes it): binds
   * (from, value, receiver) — the relay calls receiver.pull with this sig.
   */
  async signEip3009(
    receiver: string, value: bigint,
    validAfter = 0n, validBefore?: bigint, nonce?: string,
  ): Promise<{ v: number; r: string; s: string; validAfter: bigint; validBefore: bigint; nonce: string }> {
    const usdc = new Contract(this.cfg.usdc, ERC20_ABI_FRAGMENT, this.cfg.provider);
    const name: string = await usdc.name();
    const version: string = await usdc.version?.() ?? '2';
    const chain = await this.cfg.provider.getNetwork();
    const domain = {
      name, version, chainId: Number(chain.chainId),
      verifyingContract: this.cfg.usdc,
    };
    const types = {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };
    const vb = validBefore ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
    const nc = nonce ?? '0x' + toHex64((hashBn(cryptoRandBytes()) % (1n << 200n)));
    const from = await this.cfg.signer.getAddress();
    const valueObj = {
      from, to: receiver, value, validAfter, validBefore: vb, nonce: nc,
    };
    const sig = await (this.cfg.signer as Signer).signTypedData(domain, types, valueObj);
    const { Signature } = await import('ethers');
    const parsed = Signature.from(sig);
    return {
      v: parsed.yParity + 27, r: parsed.r, s: parsed.s,
      validAfter, validBefore: vb, nonce: nc,
    };
  }

  // ── spend (6.3, 10.1): change / envelope / stealth / cashout ───────

  async spend(opts: SpendOptions): Promise<SpendResult> {
    if (!this.keys) throw new Error('not initialized');
    const { assetId, note, mode } = opts;
    const ringSize = opts.ringSize ?? 32;
    if (ringSize < MIN_RING || ringSize > MAX_RING) throw new Error('RingTooSmall');
    const realX = toBytes(note.X);
    // кольцо только из реестра СВОЕЙ пары (assetId, di) — core проверяет
    // pairMembers[key][X] для каждого члена (UnknownCommitment)
    const pairLive = opts.liveNotes
      ? opts.liveNotes.filter((n) => !n.spent && n.assetId === assetId && n.di === note.di)
      : (opts.liveCommitments ?? []).map((X) => ({ X, spent: false }));
    const ring = pickRing(pairLive.map((n) => toBytes(n.X)), realX, ringSize);
    const realIndex = ring.findIndex(
      (r) => r.length === realX.length && r.every((b, i) => b === realX[i]),
    );

    const core = this.cfg.core;
    const chainId = (await this.cfg.provider.getNetwork()).chainId;
    let outputs: SpendOptions extends never ? never : {
      change?: { di: number[]; E: Uint8Array[]; X: Uint8Array[] };
      env?: {
        id: string; assetId: number; di: number[]; expiry: bigint;
        permitRequired: boolean;
        E_r: Uint8Array; X_r: Uint8Array; E_s: Uint8Array; X_s: Uint8Array;
      };
      payee?: { di: number[]; E: Uint8Array[]; X: Uint8Array[] };
    } = {};
    let recipient = core;

    if (mode === 'change') {
      const d = denomOf(assetId, note.di);
      const fee = feeTransfer(assetId, d);
      // консервация ядра: sum(change) + fee == d — сдача всегда весь остаток
      const keep = opts.changeAmount ?? d - fee;
      if (keep + fee !== d) {
        throw new Error(`ChangeAmountMismatch: keep must equal d - fee (${d - fee}), got ${keep}`);
      }
      const batch = buildChangeBatch(assetId, keep, this.keys.viewSecret, this.keys.spendSecret);
      outputs.change = batch;
    } else if (mode === 'envelope') {
      const env = opts.envelope!;
      const d = denomOf(assetId, note.di);
      const fee = feeTransfer(assetId, d);
      const dis = decompose(assetId, env.amount);
      if (sumOf(assetId, dis) + fee !== d) throw new Error('ChangeMismatch');
      const id = envelopeId();
      const meta = env.recipientMeta ?? this.metaAddress();
      const { E_r, X_r, E_s, X_s } = envelopePoints(meta, env.permitRequired);
      outputs.env = {
        id, assetId, di: dis, expiry: env.expiry, permitRequired: env.permitRequired,
        E_r, X_r, E_s, X_s,
      };
    } else if (mode === 'stealth') {
      recipient = '0x' + '00'.repeat(20);
      const d = denomOf(assetId, note.di);
      const fee = feeTransfer(assetId, d);
      const meta = opts.payeeMeta!;
      const amount = d - fee;
      outputs.payee = buildPayeeBatchTo(assetId, amount, meta);
    } else {
      // cashout
      recipient = opts.payoutReceiver!;
      const reg = await this.core.payoutReceiverRegistered(recipient);
      if (!reg) throw new Error('UnregisteredReceiver');
      outputs = {}; // raw amount paid by executor: denomOf − feeOut
    }

    const signed = signSpend(
      { assetId, di: note.di, recipient, chainId, ring, outputs },
      realIndex, BigInt(note.y),
    );

    const executor = new Contract(this.executorAddr, EXECUTOR_ABI, this.cfg.signer);
    const inner = CORE_IFACE.encodeFunctionData('spend', [{
      assetId, di: note.di, recipient,
      ring: ring.map((r) => '0x' + Buffer.from(r).toString('hex')),
      hp: signed.hp.map((h) => '0x' + Buffer.from(h).toString('hex')),
      I: '0x' + Buffer.from(signed.I).toString('hex'),
      c1: signed.c1,
      s: signed.s,
      change: outputs.change ?? { di: [], E: [], X: [] },
      env: outputs.env ?? {
        id: zeroId(), assetId: 0, di: [], expiry: 0n, permitRequired: false,
        E_r: '0x', X_r: '0x', E_s: '0x', X_s: '0x',
      },
      payee: outputs.payee ?? { di: [], E: [], X: [] },
    }]);
    // executor глотает реверт ядра (_coreSpend → bool): проявляем ошибку заранее
    await this.cfg.provider
      .call({ from: this.executorAddr, to: this.cfg.core, data: inner })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
        throw new Error(`core.spend revert [${inner.slice(0, 10)}]: ${msg}`);
      });
    const tx = await executor.execute(inner);
    const rc = await tx.wait();

    const res: SpendResult = {
      txHash: rc.hash,
      nullifier: nullifierOfKey(signed.I),
      ringSize,
    };
    if (outputs.change) {
      res.changeNotes = outputs.change.di.map((di, j) => ({
        X: '0x' + Buffer.from(outputs.change!.X[j]).toString('hex'), di,
      }));
    }
    if (outputs.env) res.envId = '0x' + Buffer.from(bytesOf(outputs.env.id)).toString('hex');
    if (mode === 'cashout') {
      const { net } = cashoutAmount(assetId, note.di);
      res.amountOut = net;
      res.payoutTo = recipient;
    }
    return res;
  }

  // ── envelopes (9.x) ────────────────────────────────────────────────

  async envelopeView(id: string): Promise<EnvelopeView> {
    const e = await this.core.envelope(id);
    return {
      id, assetId: Number(e.assetId), di: e.di.map(Number),
      openAt: e.openAt, expiry: e.expiry,
      open: e.open, claimed: e.claimed, permitRequired: e.permitRequired,
    };
  }

  /**
   * Claim an envelope: derives the m note secrets y_j = y_r + h_j, checks
   * X_j from the chain, then calls claimEnvelope (permit when required).
   */
  async claimEnvelope(
    id: string, m: number, di: number[], assetId: number,
  ): Promise<{ notes: Array<{ X: string; y: string; di: number }>; permitSig?: string }> {
    void assetId;
    const view = await this.envelopeView(id);
    if (!view.open || view.claimed) throw new Error('EnvelopeClosed');
    const e = await this.core.envelope(id);
    const X_r = decodeUnchecked(e.X_r);
    if (!this.keys) throw new Error('not initialized');
    const Er = decodeUnchecked(e.E_r);
    // y_r = H(v·E_r) + p (6.1, scanner derivation)
    const sh = hashBn(encode(ecMulLocal(this.keys.viewSecret, Er)));
    const yBase = (sh + this.keys.spendSecret) % N;
    // verify against the branch point: X_r == yBase·G when we own the branch
    const yG = mulG(yBase);
    if (yG.x !== X_r.x || yG.y !== X_r.y) throw new Error('NotEnvelopeOwner');

    const notes: Array<{ X: string; y: string; di: number }> = [];
    for (let j = 0; j < m; j++) {
      const yj = envelopeNoteSecret(yBase, id, j);
      const Xj = envelopeNotePoint(e.X_r, id, j);
      notes.push({
        X: '0x' + toHex64(Xj.x) + toHex64(Xj.y).slice(2),
        y: '0x' + yj.toString(16).padStart(64, '0'),
        di: di[j],
      });
      void assetId;
    }

    if (view.permitRequired) {
      // The permit signs over the sender key y_s — the claimer cannot produce
      // it; it must be supplied out-of-band by the sender (9.1).
      throw new Error('ClaimPermissionRequired: obtain sig from sender');
    }
    const tx = await this.core.claimEnvelope(id, '0x');
    await tx.wait();
    return { notes };
  }

  async refundEnvelope(id: string): Promise<string> {
    const tx = await this.core.refundEnvelope(id);
    const rc = await tx.wait();
    return rc.hash;
  }

  /** Sender-side permit (Schnorr over id with the X_s secret y_s). */
  buildEnvelopePermit(id: string, ySenderBase: bigint): string {
    return Buffer.from(schnorrSign(ySenderBase, hexToBytes(id)).sig).toString('hex').replace(/^/, '0x');
  }

  // ── fees (6.7) ─────────────────────────────────────────────────────

  async feesView(assetId: number): Promise<{
    accrued: bigint; withdrawn: bigint; bps: { in: bigint; transfer: bigint; out: bigint };
  }> {
    const executor = new Contract(this.executorAddr, EXECUTOR_ABI, this.cfg.provider);
    const [bpsIn, bpsTransfer, bpsOut] = await this.core.feesOf(assetId);
    const accrued = await this.core.feesAccrued(assetId);
    const withdrawn = await executor.feesWithdrawn(assetId);
    return { accrued, withdrawn, bps: { in: bpsIn, transfer: bpsTransfer, out: bpsOut } };
  }

  async sweepFees(assetId: number, amount: bigint): Promise<string> {
    const executor = new Contract(this.executorAddr, EXECUTOR_ABI, this.cfg.signer);
    const tx = await executor.sweepFees(assetId, await this.cfg.signer.getAddress(), amount);
    const rc = await tx.wait();
    return rc.hash;
  }

  // ── helpers ────────────────────────────────────────────────────────

  denomValue(assetId: number, di: number): bigint {
    return denomOf(assetId, di);
  }

  format(assetId: number, v: bigint): string {
    return formatUnits(v, ASSETS[assetId].decimals);
  }

  parse(assetId: number, human: string): bigint {
    return parseUnits(human, ASSETS[assetId].decimals);
  }
}

// ── module-level utils ──────────────────────────────────────────────

import { ecMul } from '../crypto/bn254.js';
import { keccak256 } from 'ethers';

const ERC20_ABI_FRAGMENT = [
  'function name() external view returns (string)',
  'function version() external view returns (string)',
  'function decimals() external view returns (uint8)',
];

const TREASURY_PLACEHOLDER = '0x0000000000000000000000000000000000000000';

import { Interface } from 'ethers';
const RECEIVER_CTOR = new Interface([
  'constructor(address core, address pool, address asset, address treasury, uint256 assetId, uint256 depositAmount, uint256[] denomIndices, bytes[] ephemerals, bytes[] commitments)',
]);

function concatHex(a: string, b: string): string {
  return a + b.replace(/^0x/, '');
}

function toHex64(v: bigint): string {
  return '0x' + v.toString(16).padStart(64, '0');
}

function hexToBytes(hexish: string): Uint8Array {
  const h = hexish.toLowerCase().replace(/^0x/, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBytes(hexish: string): Uint8Array {
  const h = hexish.toLowerCase().replace(/^0x/, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function cryptoRandBytes(): Uint8Array {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

function ecMulLocal(k: bigint, pt: Point): Point {
  return ecMul(k, pt);
}

function envelopeId(): string {
  return keccak256(cryptoRandBytes());
}

function zeroId(): string {
  return '0x' + '00'.repeat(32);
}

function bytesOf(hexish: string): Uint8Array {
  return toBytes(hexish);
}

/**
 * Envelope branch points (9.1): the sender derives E_r/E_s fresh and the
 * branch commitment X = H(e·V)·G + P over the recipient (claim) / self
 * (refund) meta-address.
 */
function envelopePoints(
  meta: MetaAddress, _permitRequired: boolean,
): { E_r: Uint8Array; X_r: Uint8Array; E_s: Uint8Array; X_s: Uint8Array } {
  const mk = (): { E: Uint8Array; X: Uint8Array } => {
    const e = (hashBn(cryptoRandBytes()) % (N - 1n)) + 1n;
    const Ep = mulG(e);
    const s = hashBn(encode(ecMul(e, meta.V)));
    const X = ecAddLocal(mulG(s), meta.P);
    return { E: encode(Ep), X: encode(X) };
  };
  const claim = mk();
  const refund = mk();
  return { E_r: claim.E, X_r: claim.X, E_s: refund.E, X_s: refund.X };
}

import { ecAdd } from '../crypto/bn254.js';
function ecAddLocal(a: Point, b: Point): Point {
  return ecAdd(a, b);
}
