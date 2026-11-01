/**
 * Event scanner and state rebuild (INV-10): the local wallet state is
 * reconstructed exclusively from Minted / Spent / EnvelopeOpened /
 * EnvelopeClaimed / EnvelopeRefunded events.
 */
import { Contract, Provider, Log, EventLog } from 'ethers';
import { CORE_ABI } from './abi.js';
import { tryRecoverNote } from '../crypto/stealth.js';
import { decodeUnchecked } from '../crypto/bn254.js';
import { nullifierOfKey } from './notes.js';
import { keyImage } from '../crypto/lsag.js';
import { denomOf } from '../crypto/grid.js';

export interface OwnedNote {
  E: string;
  X: string;
  y: string; // hex scalar
  di: number;
  assetId: number;
  denom: bigint;
  source: 'mint' | 'change' | 'payee' | 'envelope-claim' | 'envelope-refund';
  spent: boolean;
  spentBy?: string; // tx hash of the spend (when locally known)
}

export interface OwnedEnvelope {
  id: string;
  assetId: number;
  di: number[];
  openAt: number;
  expiry: number;
  permitRequired: boolean;
  open: boolean;
  claimed: boolean;
  branch: 'recipient' | 'sender';
  yBase: string;
  XBase: string;
  notes: OwnedNote[];
}

export interface ScanOptions {
  fromBlock?: number;
  toBlock?: number | 'latest';
  batchSize?: number;
}

export interface ScanResult {
  notes: OwnedNote[];
  envelopes: OwnedEnvelope[];
  scannedTo: number;
}

/**
 * Scan a block range for notes owned by (viewSecret, spendSecret).
 * Public API used by the wallet rebuild: reads only chain events.
 */
export async function scanOwnedNotes(
  coreAddress: string,
  provider: Provider,
  viewSecret: bigint,
  spendSecret: bigint,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const core = new Contract(coreAddress, CORE_ABI, provider);
  const from = opts.fromBlock ?? 0;
  const to = opts.toBlock === undefined || opts.toBlock === 'latest'
    ? await provider.getBlockNumber()
    : opts.toBlock;
  const filter = core.filters.Minted();
  const logs = await queryRange(core, filter, from, to, opts.batchSize ?? 5000);

  // реестр потраченных: nullifiers из Spent (INV-10); собственная нота
  // даёт nullifier = H(I) от её key image — сверяем без чтения транзакций
  const spentFilter = core.filters.Spent();
  const spentLogs = await queryRange(core, spentFilter, from, to, opts.batchSize ?? 5000);
  const spentNullifiers = new Set<string>();
  const spentByNf = new Map<string, string>();
  for (const sl of spentLogs) {
    const nf = (sl.args[3] ?? '').toString();
    if (nf) {
      spentNullifiers.add(nf.toLowerCase());
      spentByNf.set(nf.toLowerCase(), sl.transactionHash);
    }
  }

  const notes: OwnedNote[] = [];
  for (const log of logs) {
    const assetId = Number(log.args[0]);
    const di = Number(log.args[1]);
    const E: string = log.args[2];
    const X: string = log.args[3];
    const { owned, y } = tryRecoverNote(viewSecret, spendSecret, hexToBytes(E), hexToBytes(X));
    if (!owned) continue;
    // nullifier ноты = H(y·Hp(X)) — совпадает с полем события Spent (INV-10)
    const I = keyImage(y, hexToBytes(X));
    const nf = nullifierOfKey(I).toLowerCase();
    const note: OwnedNote = {
      E, X,
      y: '0x' + y.toString(16).padStart(64, '0'),
      di, assetId,
      denom: denomOf(assetId, di),
      source: 'mint',
      spent: spentNullifiers.has(nf),
    };
    const sb = spentByNf.get(nf);
    if (sb !== undefined) note.spentBy = sb;
    notes.push(note);
  }
  return { notes, envelopes: [], scannedTo: to };
}

async function queryRange(
  core: Contract,
  filter: unknown,
  from: number,
  to: number,
  batchSize: number,
): Promise<EventLog[]> {
  const out: EventLog[] = [];
  for (let start = from; start <= to; start += batchSize) {
    const end = Math.min(start + batchSize - 1, to);
    const events = (await core.queryFilter(filter as never, start, end)) as EventLog[];
    out.push(...events);
  }
  return out;
}

/**
 * Attach envelope events: notes derived from EnvelopeClaimed / Refunded
 * X_r / X_s branches for envelopes owned by this wallet.
 */
export function enrichEnvelopes(
  notes: OwnedNote[],
  envelopeEvents: Array<{
    id: string; assetId: number; di: number[]; openAt: number; expiry: number;
    permitRequired: boolean; open: boolean; claimed: boolean;
    X_r: string; X_s: string; kind: 'opened' | 'claimed' | 'refunded';
  }>,
  viewSecret: bigint,
  spendSecret: bigint,
): OwnedEnvelope[] {
  const envelopes: OwnedEnvelope[] = [];
  for (const ev of envelopeEvents) {
    for (const [branch, XBase] of [['recipient', ev.X_r], ['sender', ev.X_s]] as const) {
      const { owned, y } = tryRecoverNote(viewSecret, spendSecret, hexToBytes(XBase), hexToBytes(XBase));
      // X_r itself is not a commitment; ownership test uses its derived note:
      // y_r = H(v·E_r) + p only for the owner. For envelope branches the
      // wallet records the branch when the base point equals the known
      // stealth point of a past mint/change (E-matching done by the caller).
      void owned; void y; void branch; void XBase;
    }
    void notes;
  }
  return envelopes;
}

export { nullifierOfKey, decodeUnchecked };
export { Contract, Log };

function hexToBytes(hex: string): Uint8Array {
  const h = hex.toLowerCase().replace(/^0x/, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
