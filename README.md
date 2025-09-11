# LaserGun Protocol SDK

[![npm version](https://badge.fury.io/js/%40lasergun-protocol%2Fsdk.svg)](https://badge.fury.io/js/%40lasergun-protocol%2Fsdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

TypeScript SDK for LaserGun privacy protocol - anonymous ERC20 transfers with zero-knowledge proofs.

## 🚀 Quick Start

### Installation

```bash
npm install @lasergun-protocol/sdk ethers
```

### Basic Setup

```typescript
import LaserGun, { LocalStorageAdapter } from '@lasergun-protocol/sdk';
import { ethers } from 'ethers';

// Configure the SDK
const config = {
  contractAddress: '0x7a9046293dF17d2ec81eF4606376bFE1b45A2f18', // Amoy testnet
  chainId: 80002,
  provider: new ethers.JsonRpcProvider('your-rpc-url'),
  signer: wallet, // ethers Wallet or Signer
  signMessage: 'LaserGun Key Generation' // Optional: custom message for key derivation
};

// Create storage adapter
const storage = new LocalStorageAdapter();

// Initialize SDK
const lasergun = new LaserGun(config, storage);
await lasergun.initialize();
```

## 📋 Core Operations

### Shield (Make Tokens Private)

Convert public ERC20 tokens into private shields:

```typescript
// Shield 100 tokens (tokens become private)
const result = await lasergun.shield(
  ethers.parseUnits('100', 18), // amount
  '0x...' // token address
);

console.log('Shield created:', result.commitment);
console.log('Net amount:', result.netAmount);
console.log('Fee paid:', result.fee);
```

### Unshield (Convert Back to Public)

Convert private shields back to public tokens:

```typescript
// Get your shields
const shields = await lasergun.getUserShields();
const shield = shields[0];

// Unshield all tokens
const result = await lasergun.unshield(
  shield.secret,           // secret from shield
  shield.amount,           // amount to withdraw
  '0x...',                // recipient address
  shield.token             // token address
);

// Partial unshield (with remainder)
const partialResult = await lasergun.unshield(
  shield.secret,
  ethers.parseUnits('50', 18), // withdraw only 50 tokens
  '0x...',                     // recipient address
  shield.token
);
console.log('Remainder commitment:', partialResult.remainderCommitment);
```

### Anonymous Transfer

Transfer private tokens to another user:

```typescript
// Generate recipient commitment and encrypt secret (complex process)
// This requires recipient's public key and ECIES encryption
const recipientCommitment = '0x...'; // Generated commitment for recipient
const encryptedSecret = '0x...';     // ECIES encrypted secret

// Transfer tokens anonymously - REQUIRES commitment and encrypted secret!
const result = await lasergun.transfer(
  shield.secret,           // your shield secret
  '25',                    // amount to transfer (string)
  recipientCommitment,     // recipient's commitment (HexString)
  encryptedSecret          // ECIES encrypted secret for recipient (string)
);

console.log('Recipient commitment:', result.recipientCommitment);
console.log('Your remainder:', result.remainderCommitment);
```

### Consolidate Shields

Combine multiple shields into one:

```typescript
// Get multiple shields for same token
const tokenShields = await lasergun.getTokenShields('0x...');
const secrets = tokenShields.map(s => s.secret);

// Consolidate into single shield
const result = await lasergun.consolidate(secrets, '0x...');
console.log('New consolidated commitment:', result.recipientCommitment);
```

## 🔍 Querying Data

### Get Balances

```typescript
// Get combined public + private balance
const balance = await lasergun.getTokenBalance('0x...');
console.log('Public balance:', balance.publicBalance);
console.log('Private balance:', balance.privateBalance);
console.log('Total:', ethers.formatUnits(
  BigInt(balance.publicBalance) + BigInt(balance.privateBalance), 
  balance.decimals
));
```

### Get Transaction History

```typescript
// Get all transactions
const history = await lasergun.getTransactionHistory();

// Filter by type
const shields = history.filter(tx => tx.type === 'shield');
const transfers = history.filter(tx => tx.type === 'transfer');
const received = history.filter(tx => tx.type === 'received');
```

### Get User Shields

```typescript
// Get all shields
const allShields = await lasergun.getUserShields();

// Get shields for specific token
const tokenShields = await lasergun.getTokenShields('0x...');

// Check individual shield
const shield = await lasergun.getShield('commitment_hash');
```

## 🔐 Key Management

### ECIES Key Generation

The SDK automatically generates deterministic ECIES keys for encryption:

```typescript
// Initialize automatically generates keys
await lasergun.initialize();

// Get public key for registration
const publicKey = lasergun.getPublicKey();

// Register on contract (required for receiving transfers)
await lasergun.ensurePublicKeyRegistered();

// Check registration status
const isRegistered = await lasergun.isPublicKeyRegistered();
```

### HD Derivation

The SDK uses hierarchical deterministic (HD) key derivation for enhanced privacy:

```typescript
// Keys are derived deterministically from your wallet signature
// Each operation type gets its own derivation path:
// - Shield operations: m/shield/0, m/shield/1, ...
// - Remainder operations: m/remainder/0, m/remainder/1, ...
// - Received transfers: m/received/0, m/received/1, ...
// - Consolidation: m/consolidate/0, m/consolidate/1, ...
```

## 🔄 Event Scanning & Recovery

### Automatic Event Monitoring

```typescript
// Configure scanner
const scannerConfig = {
  startBlock: 45000000,    // Block to start scanning from
  batchSize: 5000,         // Events per batch
  enableHDRecovery: true,  // Enable HD-based recovery
  maxHDIndex: 1000        // Maximum HD index to check
};

// Start automatic scanning
await lasergun.startScanner(true); // true = auto-recover missing data

// Listen for real-time events
lasergun.onTransaction((transaction) => {
  console.log('New transaction:', transaction.type, transaction.amount);
});

lasergun.onError((error) => {
  console.error('Scanner error:', error.message);
});

lasergun.onStateChange((state) => {
  console.log('Scanner state:', state.isRunning, state.currentBlock);
});
```

### Data Recovery
```typescript
// Sync local data with blockchain
const sync = await lasergun.syncWithBlockchain();
console.log(`Added: ${sync.added}, Updated: ${sync.updated}, Removed: ${sync.removed}`);

// Validate data integrity
const validation = await lasergun.validateDataIntegrity();
if (!validation.isValid) {
  console.log('Issues found:', validation.issues);
  console.log('Suggestions:', validation.suggestions);
}
```

## 🏗️ Architecture

### Core Components

- **LaserGun** - Main SDK class with all operations
- **EventScanner** - Real-time blockchain event monitoring with HD recovery
- **CryptoService** - ECIES encryption and HD key derivation
- **StorageAdapter** - Pluggable data persistence (localStorage, custom)
- **ConfigManager** - Contract interaction and configuration
- **Operations Modules** - Modular shield, transfer, and token operations

### Data Flow

```
1. Shield:    Public Tokens → Private Shield → HD-derived secret
2. Transfer:  Shield Secret → ECIES Encrypted → Recipient Shield  
3. Unshield:  Shield Secret → Public Tokens + Optional Remainder
4. Recovery:  Blockchain Events → HD Path Discovery → Secret Recreation
```

### Privacy Model

- **Commitments**: `keccak256(secret, recipient_address)` - hide ownership
- **HD Secrets**: Deterministic generation from wallet signatures
- **ECIES Encryption**: Secure secret delivery to recipients
- **Event Scanning**: No on-chain address linkage during recovery

## 🔧 Configuration

### Storage Adapters

```typescript
// Built-in localStorage adapter
import { LocalStorageAdapter } from '@lasergun-protocol/sdk';
const storage = new LocalStorageAdapter();

// Custom storage adapter
import { StorageAdapter } from '@lasergun-protocol/sdk';

class CustomAdapter extends StorageAdapter {
  async saveTransaction(chainId, wallet, nonce, transaction) {
    // Your implementation
  }
  
  async loadTransactions(chainId, wallet) {
    // Your implementation
  }
  
  // ... implement all required methods
}
```

### Network Configuration

```typescript
const config = {
  contractAddress: '0x...',    // LaserGun contract address
  chainId: 80002,              // Network chain ID
  provider: provider,          // ethers.js Provider
  signer: signer,             // ethers.js Signer
  signMessage: 'Custom'       // Optional: custom key derivation message
};
```

### Scanner Configuration

```typescript
const scannerConfig = {
  startBlock: 45000000,        // Starting block for event scanning
  batchSize: 5000,            // Events to process per batch
  enableHDRecovery: true,     // Enable HD-based secret recovery
  maxHDIndex: 1000           // Maximum HD index to check
};
```

## 🛡️ Security Features

### Key Security

- **Deterministic Generation**: Keys derived from wallet signatures
- **No Key Storage**: Private keys never stored, always regenerated
- **HD Derivation**: Unique secrets for each operation type
- **Local Only**: All cryptographic operations happen client-side

### Privacy Protection

- **Commitment Scheme**: Hide shield ownership and amounts
- **ECIES Encryption**: Secure secret delivery without address exposure
- **Event Unlinkability**: No on-chain connection between sender/recipient
- **Metadata Isolation**: Each operation uses fresh derived secrets

## 📚 API Reference

### Core Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `initialize()` | Initialize SDK and generate keys | `Promise<void>` |
| `shield(amount, token)` | Convert public tokens to private | `Promise<ShieldResult>` |
| `unshield(secret, amount, recipient, token)` | Convert private to public | `Promise<UnshieldResult>` |
| `transfer(secret, amount, recipient, token)` | Anonymous private transfer | `Promise<TransferResult>` |
| `consolidate(secrets, token)` | Merge multiple shields | `Promise<TransferResult>` |

### Query Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `getTokenBalance(token)` | Public + private balance | `Promise<TokenBalance>` |
| `getUserShields()` | All user shields | `Promise<Shield[]>` |
| `getTokenShields(token)` | Shields for specific token | `Promise<Shield[]>` |
| `getTransactionHistory()` | All transactions | `Promise<Transaction[]>` |
| `getShield(commitment)` | Get specific shield | `Promise<Shield \| null>` |

### Recovery Methods

| Method | Description | Returns |
|--------|-------------|---------| 
| `syncWithBlockchain()` | Sync local with blockchain | `Promise<SyncResult>` |
| `validateDataIntegrity()` | Check data consistency | `Promise<ValidationResult>` | 

### Utility Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `startScanner(autoRecover?)` | Start event monitoring | `Promise<void>` |
| `stopScanner()` | Stop event monitoring | `Promise<void>` |
| `ensurePublicKeyRegistered()` | Register ECIES public key | `Promise<void>` |
| `isPublicKeyRegistered()` | Check key registration | `Promise<boolean>` |
| `getWallet()` | Get wallet address | `string` |
| `getPublicKey()` | Get ECIES public key | `string` |

## 🎛️ Event Callbacks

```typescript
// Transaction events
lasergun.onTransaction((transaction: Transaction) => {
  console.log(`${transaction.type}: ${transaction.amount}`);
});

// Error handling
lasergun.onError((error: LaserGunError) => {
  console.error(`Error ${error.code}: ${error.message}`);
});

// Scanner state changes
lasergun.onStateChange((state: ScannerState) => {
  console.log(`Scanner: ${state.isRunning ? 'running' : 'stopped'}`);
  console.log(`Current block: ${state.currentBlock}`);
});
// 
lasergun.onBlockScanned((blockId: Number) => {
  console.log(`Last block scanned: ${blockId}`);
});
```

## 🧪 Testing

### Unit Tests

```bash
npm test
```

### Integration Tests

```bash
# Requires running blockchain node
npm run test:integration
```

### Coverage

```bash
npm run test:coverage
```

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md).

### Development Setup

```bash
git clone https://github.com/lasergun-protocol/sdk
cd sdk
npm install
npm run build
npm run test
```

### Build

```bash
npm run build          # Build distribution
npm run build:watch    # Watch mode
npm run typecheck      # Type checking only
```

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🔗 Links

- **Website**: [https://lasergun.xyz](https://lasergun.xyz)
- **Documentation**: [https://docs.lasergun.xyz](https://docs.lasergun.xyz)
- **Contract Repository**: [https://github.com/lasergun-protocol/contracts](https://github.com/lasergun-protocol/contracts)
- **Discord**: [https://discord.gg/CQXM99fCbn](https://discord.gg/CQXM99fCbn)  
- **Twitter**: [@LaserGunProto](https://x.com/lasergun_proto)

## 🛠️ Supported Networks

- **Polygon Amoy Testnet**: `0x7a9046293dF17d2ec81eF4606376bFE1b45A2f18`
- **Mainnet**: Coming soon

---

**⚠️ Security Notice**: This is experimental software. Use at your own risk. Always verify contract addresses and test with small amounts first.