# LaserGun Protocol SDK

[![npm version](https://badge.fury.io/js/%40lasergun-protocol%2Fsdk.svg)](https://badge.fury.io/js/%40lasergun-protocol%2Fsdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

TypeScript SDK for the [LaserGun](https://lasergun.xyz) privacy protocol. The package wraps the on-chain LaserGun contract and ships batteries-included helpers for generating deterministic secrets, shielding ERC-20 balances, performing anonymous transfers, and keeping a local cache in sync with blockchain events.

**Why use the SDK?**
- Works with modern **ethers v6** BigInt flows (peer dependency).
- Deterministic HD derivation for every operation (shield, transfer, unshield, remainder, consolidate, received).
- Pluggable storage adapters for browsers or custom server backends.
- Event scanner with recovery utilities to rebuild local state safely.
- Strongly typed results, descriptive `LaserGunError` codes, and convenience utilities for crypto primitives.

## Table of Contents
- [Getting Started](#getting-started)
  - [Installation](#installation)
  - [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [Storage Adapters](#storage-adapters)
  - [Browser Local Storage](#browser-local-storage)
  - [Example: In-memory Node Adapter](#example-in-memory-node-adapter)
- [Core Operations](#core-operations)
  - [Shielding Tokens](#shielding-tokens)
  - [Unshielding Back to Public Tokens](#unshielding-back-to-public-tokens)
  - [Private Transfers](#private-transfers)
  - [Consolidating Multiple Shields](#consolidating-multiple-shields)
  - [Deriving Secrets Manually](#deriving-secrets-manually)
- [Receiving Private Transfers](#receiving-private-transfers)
- [Token & Balance Utilities](#token--balance-utilities)
- [Querying Cached Data](#querying-cached-data)
- [Scanner & Realtime Updates](#scanner--realtime-updates)
- [Recovery & Maintenance](#recovery--maintenance)
- [Utilities & Helper Exports](#utilities--helper-exports)
- [Error Handling](#error-handling)
- [Development](#development)
- [Supported Networks](#supported-networks)
- [Links](#links)
- [License](#license)
- [Security Notice](#security-notice)

## Getting Started

### Installation

```bash
npm install @lasergun-protocol/sdk ethers
# or
yarn add @lasergun-protocol/sdk ethers
```

> **Prerequisites**
> - Node.js ≥ 18
> - `ethers` ≥ 6.7 (peer dependency)
> - An account with funds on the network you intend to use
> - Access to an RPC endpoint (e.g. Polygon Amoy)

### Quick Start

1. **Configure environment variables** for your RPC endpoint and signer. A `.env` file works well during development:
   ```env
   AMOY_RPC=https://rpc-amoy.polygon.technology
   PRIVATE_KEY=0xabc123...
   ```
2. **Instantiate LaserGun** with a provider, signer, and storage adapter. The SDK includes a browser-ready `LocalStorageAdapter`; for Node.js you can bring your own (see [Storage Adapters](#storage-adapters)).
3. **Call `initialize()`** once per session to derive deterministic keys, register your public key with the contract, load persisted data, and prime the event scanner.
4. **Execute operations** such as `shield`, `unshield`, or `transfer`. All monetary values are `bigint`—use `parseUnits` / `formatUnits` from `ethers` for conversions.

```typescript
import 'dotenv/config';
import { JsonRpcProvider, Wallet, parseUnits, formatUnits } from 'ethers';
import LaserGun, { LocalStorageAdapter } from '@lasergun-protocol/sdk';

const provider = new JsonRpcProvider(process.env.AMOY_RPC!);
const signer = new Wallet(process.env.PRIVATE_KEY!, provider);

const lasergun = new LaserGun(
  {
    contractAddress: '0x7a9046293dF17d2ec81eF4606376bFE1b45A2f18',
    chainId: 80002,
    provider,
    signer,
    signMessage: 'LaserGun Key Generation Demo' // optional custom derivation message
  },
  new LocalStorageAdapter()
);

await lasergun.initialize();

const amount = parseUnits('5', 18);
const { success, commitment, netAmount, fee } = await lasergun.shield(amount, '0xYourTokenAddress');

if (success) {
  console.log('Shield commitment:', commitment);
  console.log('Net amount credited:', formatUnits(netAmount ?? 0n, 18));
  console.log('Protocol fee:', formatUnits(fee ?? 0n, 18));
}
```

After initialization you can start the event scanner, send private transfers, or recover persisted data using the sections below.

## Configuration Reference

`LaserGun` expects a `LaserGunConfig` object:

| Property | Type | Description |
| --- | --- | --- |
| `contractAddress` | `string` | LaserGun contract address on the current network |
| `chainId` | `number` | EVM chain id (e.g. `80002` for Polygon Amoy) |
| `provider` | `Provider` | Ethers v6 provider used for reads and scanner operations |
| `signer` | `Signer` | Ethers v6 signer used for transactions and deterministic key derivation |
| `signMessage?` | `string` | Optional custom message for signing during key derivation |

You can optionally pass a `ScannerConfig` as the third constructor argument (or to helper creators) to fine-tune event scanning:

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `startBlock` | `number` | `0` | First block to inspect when recovering history |
| `batchSize` | `number` | `1000` | Number of blocks fetched per scanner batch |
| `enableHDRecovery` | `boolean` | `true` | Automatically run HD recovery before scanning |
| `maxHDIndex` | `number` | `1000` | Limit for HD brute force when recovering gaps |

## Storage Adapters

The SDK persists encrypted keys, shields, transactions, HD counters, and scanner progress through the `IStorageAdapter` interface. You can plug in any implementation that extends the abstract `StorageAdapter` base class.

### Browser Local Storage

```typescript
import { LocalStorageAdapter } from '@lasergun-protocol/sdk';

const storage = new LocalStorageAdapter(); // requires window.localStorage
const lasergun = new LaserGun(config, storage);
```

> `LocalStorageAdapter` throws if `window.localStorage` is unavailable (e.g. Node.js). Use a custom adapter for server environments.

### Example: In-memory Node Adapter

The snippet below implements a minimal in-memory adapter. It is suitable for tests or short-lived scripts and demonstrates the required methods for a production-ready adapter (swap the `Map` usage for a database or filesystem persistence in real projects).

```typescript
import {
  StorageAdapter,
  type Transaction,
  type Shield,
  type CryptoKeys,
  type EventCounts
} from '@lasergun-protocol/sdk';

class InMemoryStorageAdapter extends StorageAdapter {
  private transactions = new Map<string, Map<number, Transaction>>();
  private shields = new Map<string, Map<string, Shield>>();
  private keys = new Map<string, CryptoKeys>();
  private lastBlock = new Map<string, number>();
  private eventCounts = new Map<string, EventCounts>();

  private walletKey(chainId: number, wallet: string): string {
    return `${chainId}:${wallet.toLowerCase()}`;
  }

  async saveTransaction(chainId: number, wallet: string, nonce: number, tx: Transaction): Promise<void> {
    const key = this.walletKey(chainId, wallet);
    const map = this.transactions.get(key) ?? new Map<number, Transaction>();
    map.set(nonce, tx);
    this.transactions.set(key, map);
  }

  async loadTransactions(chainId: number, wallet: string): Promise<Transaction[]> {
    const key = this.walletKey(chainId, wallet);
    const map = this.transactions.get(key);
    return map ? [...map.values()].sort((a, b) => a.nonce - b.nonce) : [];
  }

  async getTransaction(chainId: number, wallet: string, nonce: number): Promise<Transaction | null> {
    const key = this.walletKey(chainId, wallet);
    return this.transactions.get(key)?.get(nonce) ?? null;
  }

  async getLastNonce(chainId: number, wallet: string): Promise<number> {
    const txs = await this.loadTransactions(chainId, wallet);
    return txs.length ? Math.max(...txs.map(tx => tx.nonce)) : 0;
  }

  async deleteWalletData(chainId: number, wallet: string): Promise<void> {
    const key = this.walletKey(chainId, wallet);
    this.transactions.delete(key);
    this.shields.delete(key);
    this.keys.delete(key);
    this.lastBlock.delete(key);
    this.eventCounts.delete(key);
  }

  async saveKeys(chainId: number, wallet: string, keys: CryptoKeys): Promise<void> {
    this.keys.set(this.walletKey(chainId, wallet), keys);
  }

  async loadKeys(chainId: number, wallet: string): Promise<CryptoKeys | null> {
    return this.keys.get(this.walletKey(chainId, wallet)) ?? null;
  }

  async saveShield(chainId: number, wallet: string, shield: Shield): Promise<void> {
    const key = this.walletKey(chainId, wallet);
    const map = this.shields.get(key) ?? new Map<string, Shield>();
    map.set(shield.commitment, shield);
    this.shields.set(key, map);
  }

  async loadShields(chainId: number, wallet: string): Promise<Shield[]> {
    const key = this.walletKey(chainId, wallet);
    const map = this.shields.get(key);
    return map ? [...map.values()].sort((a, b) => a.timestamp - b.timestamp) : [];
  }

  async getShield(chainId: number, wallet: string, commitment: string): Promise<Shield | null> {
    return this.shields.get(this.walletKey(chainId, wallet))?.get(commitment) ?? null;
  }

  async deleteShield(chainId: number, wallet: string, commitment: string): Promise<void> {
    this.shields.get(this.walletKey(chainId, wallet))?.delete(commitment);
  }

  async saveLastScannedBlock(chainId: number, wallet: string, blockNumber: number): Promise<void> {
    this.lastBlock.set(this.walletKey(chainId, wallet), blockNumber);
  }

  async getLastScannedBlock(chainId: number, wallet: string): Promise<number | null> {
    return this.lastBlock.get(this.walletKey(chainId, wallet)) ?? null;
  }

  async saveEventCounts(chainId: number, wallet: string, counts: EventCounts): Promise<void> {
    this.eventCounts.set(this.walletKey(chainId, wallet), counts);
  }

  async loadEventCounts(chainId: number, wallet: string): Promise<EventCounts | null> {
    return this.eventCounts.get(this.walletKey(chainId, wallet)) ?? null;
  }
}
```

Use the adapter just like the bundled one: `const lasergun = new LaserGun(config, new InMemoryStorageAdapter());`.

## Core Operations

All monetary values returned by the SDK are `bigint`. Convert to human-readable strings with `formatUnits` and convert inputs with `parseUnits`.

### Shielding Tokens

```typescript
const amount = parseUnits('50', 18);
const { success, commitment, netAmount, fee, derivationPath } = await lasergun.shield(amount, tokenAddress);

if (success) {
  console.log(`Shield stored at commitment ${commitment}`);
  console.log(`Derivation path: ${derivationPath}`); // e.g. shield/0
}
```

The SDK checks the signer’s public balance, ensures allowance for the LaserGun contract, submits the transaction, and persists the resulting shield with HD metadata. `netAmount` equals `amount - fee` using the on-chain fee schedule.

### Unshielding Back to Public Tokens

```typescript
import type { HexString } from '@lasergun-protocol/sdk';

const [firstShield] = await lasergun.getUserShields();
if (!firstShield) throw new Error('Nothing to unshield');

const withdrawAmount = firstShield.amount / 2n; // withdraw half
const result = await lasergun.unshield(
  firstShield.secret as HexString,
  withdrawAmount,
  '0xRecipientAddress'
);

if (result.success) {
  console.log('Public tokens released:', result.amount?.toString());
  if (result.remainderDerivationPath) {
    console.log('Remainder stored at', result.remainderDerivationPath);
  }
}
```

If you withdraw less than the full shield, the SDK automatically derives a remainder secret, stores the new shield, and records all operations locally.

### Private Transfers

Sending a private transfer requires two values generated off-chain: the `recipientCommitment` and an ECIES `encryptedSecret` the recipient can decrypt.

```typescript
import { CryptoService } from '@lasergun-protocol/sdk';

const recipientWallet = '0xRecipientAddress';
const recipientPublicKey = '0xRecipientPublicKey'; // recipient shares this after initialize()

const counts = await lasergun.getEventCounts();
const transferIndex = counts.transfer; // next HD slot for transfers

const recipientSecret = lasergun.deriveSecret('transfer', transferIndex);
const recipientCommitment = CryptoService.generateCommitment(recipientSecret, recipientWallet);
const encryptedSecret = await CryptoService.encryptSecret(recipientSecret, recipientPublicKey);

const transferTx = await lasergun.transfer(
  sourceShield.secret as HexString,
  parseUnits('5', 18),
  recipientCommitment,
  encryptedSecret
);

if (transferTx.success) {
  console.log('Transfer broadcast:', transferTx.txHash);
}
```

> **Tips**
> - The recipient obtains `recipientPublicKey` by calling `lasergun.getPublicKey()` after `initialize()`.
> - Share the recipient’s wallet address (needed for `generateCommitment`) over a secure channel.
> - The event scanner automatically decrypts incoming `SecretDelivered` events for the recipient—see [Receiving Private Transfers](#receiving-private-transfers).

### Consolidating Multiple Shields

Merge several shields of the same token into a single output commitment:

```typescript
const tokenShields = await lasergun.getTokenShields(tokenAddress);
const secrets = tokenShields.map(shield => shield.secret as HexString);

const consolidated = await lasergun.consolidate(secrets, tokenAddress);
if (consolidated.success) {
  console.log('New commitment:', consolidated.recipientCommitment);
}
```

### Deriving Secrets Manually

For advanced flows (pre-generating QR codes, reserving commitments, etc.) you can derive HD secrets yourself. Use the latest event counts to pick the next available index.

```typescript
const counts = await lasergun.getEventCounts();
const nextShieldSecret = lasergun.deriveSecret('shield', counts.shield);
const futureCommitment = CryptoService.generateCommitment(nextShieldSecret, lasergun.getWallet());
```

## Receiving Private Transfers

When another user sends you an encrypted secret, the SDK can decrypt and store it automatically.

```typescript
lasergun.onTransaction(tx => {
  if (tx.type === 'received') {
    console.log('New private deposit:', tx.amount.toString(), 'at', tx.commitment);
  }
});

lasergun.onError(err => console.error('Scanner issue', err.code, err.message));

await lasergun.startScanner(true); // auto-run recoverFromBlockchain() before streaming
```

`startScanner(true)` ensures your local cache matches the blockchain before monitoring new blocks. Each `SecretDelivered` event is decrypted with your HD keys; if it belongs to you, the SDK stores the shield and emits a `received` transaction callback.

To process transfers manually (without the scanner), fetch `encryptedSecret` values from transaction receipts and call `CryptoService.decryptSecret(encryptedSecret, privateKey)`.

## Token & Balance Utilities

```typescript
import { formatUnits } from 'ethers';

const balance = await lasergun.getTokenBalance(tokenAddress);
console.log(
  `${balance.symbol}: public=${formatUnits(balance.publicBalance, balance.decimals)}, ` +
  `private=${formatUnits(balance.privateBalance, balance.decimals)}`
);

const info = await lasergun.getTokenInfo(tokenAddress);
const allowance = await lasergun.getAllowance(tokenAddress);
const isSupported = await lasergun.isValidToken(tokenAddress);
```

`getTokenBalance` cross-checks local shields against the contract to verify they are still active, producing an accurate private balance.

## Querying Cached Data

| Method | Description |
| --- | --- |
| `getUserShields()` | List every shield tracked for the active wallet |
| `getTokenShields(token)` | Filter shields by ERC-20 address |
| `getTransactionHistory()` | Chronological list of operations with HD metadata |
| `getEventCounts()` | Current HD counters for each operation (throws if recovery has never been run) |
| `getWallet()` / `getPublicKey()` | Inspect the active identity and exported public key |

## Scanner & Realtime Updates

```typescript
await lasergun.startScanner(); // pass true to auto-recover first

lasergun.onBlockScanned(block => console.log('Scanner caught up to block', block));
lasergun.onStateChange(state => console.log('Scanner running?', state.isRunning));

// Later when shutting down:
await lasergun.stopScanner();
```

`EventScanner` streams blockchain events, updates HD counters, and persists results using your storage adapter. Advanced users can import `EventScanner` directly for custom orchestration.

## Recovery & Maintenance

The recovery manager helps rebuild state after reinstalling an app, switching storage backends, or verifying integrity before audits.

```typescript
await lasergun.recoverFromBlockchain();
const validation = await lasergun.validateDataIntegrity();

if (!validation.isValid) {
  console.warn('Issues detected:', validation.issues);
  console.info('Suggested fixes:', validation.suggestions);
}

const syncResult = await lasergun.syncWithBlockchain();
console.log('Sync delta:', syncResult);

const stats = await lasergun.getRecoveryStats();
console.log('Recovery stats:', stats);
```

Helper namespaces make common flows more ergonomic:

```typescript
import { recovery, diagnostics } from '@lasergun-protocol/sdk';

const instance = await recovery.createWithRecovery(config); // initialize + recover in one call
await recovery.validateIntegrity(instance);
await recovery.syncWithBlockchain(instance);

const report = await diagnostics.getDiagnostics(instance);
await diagnostics.clearWalletData(config.chainId, instance.getWallet());
await diagnostics.clearAllData();
```

## Utilities & Helper Exports

The root module exports several utilities in addition to the `LaserGun` class:

- `VERSION` – runtime version string.
- `utils`
  - `isValidHexString`, `isValidAddress`
  - `generateCommitment(secret, recipient)` and `generateSecret(privateKey, nonce)`
  - `createWithLocalStorage(config, scannerConfig?)`
  - `createWithValidation(config, scannerConfig?)` – initialize + integrity check + auto-sync on issues
- `recovery` – see [Recovery & Maintenance](#recovery--maintenance)
- `diagnostics` – diagnostic helpers shown above
- `CryptoService` – cryptographic primitives (key generation, ECIES encrypt/decrypt, HD manager factory)
- `EventScanner` – standalone scanner class for advanced integrations
- `LocalStorageAdapter` – browser storage implementation
- All public TypeScript types (`LaserGunConfig`, `ShieldResult`, `ScannerState`, `LaserGunError`, etc.)

## Error Handling

Every operation returns a success flag or throws a `LaserGunError` with a stable `ErrorCode` enum. Use these codes to display actionable messages in your app.

| Code | Meaning |
| --- | --- |
| `INVALID_CONFIG` | Configuration missing required fields or addresses |
| `NETWORK_ERROR` | Provider unreachable or chain ID mismatch |
| `CONTRACT_ERROR` | Smart contract interaction failed |
| `CRYPTO_ERROR` | Cryptographic primitive failed (encryption, HD derivation, etc.) |
| `STORAGE_ERROR` | Storage adapter rejected a read/write operation |
| `VALIDATION_ERROR` | Invalid user input (addresses, amounts, secrets) |
| `INSUFFICIENT_BALANCE` | Shield amount exceeds available public balance |
| `SCANNER_ERROR` | Scanner or recovery routine failed |
| `HD_DERIVATION_ERROR`, `EVENT_COUNT_ERROR` | HD bookkeeping problems |

When an operation returns `{ success: false, error }`, the same `LaserGunError` instance is attached for convenient UI handling.

## Development

```bash
git clone https://github.com/lasergun-protocol/sdk.git
cd sdk
npm install

npm run build       # Compile TypeScript to dist/
npm run typecheck   # tsconfig type-only check
npm run lint        # ESLint over src/
npm test            # Jest unit tests
npm run clean       # Remove dist/
```

## Supported Networks

- **Polygon Amoy Testnet**: `0x7a9046293dF17d2ec81eF4606376bFE1b45A2f18`
- **Mainnet**: coming soon

## Links

- Website: [https://lasergun.xyz](https://lasergun.xyz)
- Documentation: [https://docs.lasergun.xyz](https://docs.lasergun.xyz)
- Contracts: [https://github.com/lasergun-protocol/contracts](https://github.com/lasergun-protocol/contracts)
- Discord: [https://discord.gg/CQXM99fCbn](https://discord.gg/CQXM99fCbn)
- Twitter / X: [@LaserGunProto](https://x.com/lasergun_proto)

## License

MIT License – see [LICENSE](LICENSE).

## Security Notice

LaserGun is experimental software. Always double-check contract addresses, keep private keys secure, and test with small amounts before moving significant value. Prefer using test networks before deploying to mainnet.
