# LaserGun SDK

[![npm version](https://badge.fury.io/js/@lasergun-protocol/sdk.svg)](https://badge.fury.io/js/@lasergun-protocol/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

**Privacy-preserving ERC20 transfers on Ethereum** • Anonymous transactions • ECIES encryption • Blockchain recovery

LaserGun SDK enables completely anonymous ERC20 token transfers using commitment schemes and ECIES encryption. Shield your tokens to make them private, transfer anonymously, and unshield to any address.

## 🎯 Key Features

- **🔒 Complete Privacy** - Anonymous token transfers with zero linking
- **🛡️ Shield/Unshield** - Convert between public and private tokens
- **📨 Private Transfers** - Send tokens anonymously to other users
- **🔄 Auto-Recovery** - Restore data from blockchain after localStorage loss
- **⚡ Real-time Scanning** - Automatic detection of incoming transfers
- **🧩 Modular Design** - Pluggable storage adapters and configurations
- **🔐 ECIES Encryption** - Secure secret delivery to recipients
- **💾 Multi-chain Support** - Works on any EVM-compatible blockchain

## 🚀 Quick Start

### Installation

```bash
npm install @lasergun-protocol/sdk ethers
```

### Basic Usage

```typescript
import { LaserGun, recovery } from '@lasergun-protocol/sdk';
import { ethers } from 'ethers';

// Setup provider and signer
const provider = new ethers.JsonRpcProvider('https://rpc.ankr.com/eth');
const signer = new ethers.Wallet('your-private-key', provider);

// Create LaserGun instance with auto-recovery
const lasergun = await recovery.createWithRecovery({
  contractAddress: '0x...', // LaserGun contract address
  chainId: 1,
  provider: provider,
  signer: signer
});

// Start scanning for events
await lasergun.startScanner(true); // true = auto-recover on start
```

### Shield Tokens (Make Private)

```typescript
// Shield 100 USDT (make it private)
const result = await lasergun.shield('100', '0xA0b86a33E6441cc8c88545dba4Ad8c4c55b6A7CA');

if (result.success) {
  console.log('Tokens shielded successfully!');
  console.log('Commitment:', result.commitment);
  console.log('Net amount:', result.netAmount);
  console.log('Fee:', result.fee);
}
```

### Transfer Anonymously

```typescript
// Get your private balance
const balance = await lasergun.getTokenBalance('0xA0b86a33E6441cc8c88545dba4Ad8c4c55b6A7CA');
console.log('Private balance:', balance.privateBalance);

// Get your shields
const shields = await lasergun.getTokenShields('0xA0b86a33E6441cc8c88545dba4Ad8c4c55b6A7CA');
const secret = shields[0].secret; // Use first shield

// Transfer 50 USDT anonymously
const result = await lasergun.transfer(
  secret,
  '50',
  '0x742d35Cc6635Bb8B82a532C2F5eE9c0F87c5C3D', // recipient address
  '0xA0b86a33E6441cc8c88545dba4Ad8c4c55b6A7CA'  // token address
);

if (result.success) {
  console.log('Anonymous transfer completed!');
  console.log('Recipient commitment:', result.recipientCommitment);
}
```

### Unshield Tokens (Make Public)

```typescript
// Unshield 25 USDT to specific address
const result = await lasergun.unshield(
  secret,
  '25',
  '0x742d35Cc6635Bb8B82a532C2F5eE9c0F87c5C3D', // recipient
  '0xA0b86a33E6441cc8c88545dba4Ad8c4c55b6A7CA'  // token
);

if (result.success) {
  console.log('Tokens unshielded successfully!');
  console.log('Amount sent:', result.amount);
  console.log('Fee:', result.fee);
}
```

## 🔄 Blockchain Recovery

LaserGun SDK automatically recovers your data from the blockchain if localStorage is cleared:

### Automatic Recovery

```typescript
import { recovery } from '@lasergun-protocol/sdk';

// Automatically recovers all data on creation
const lasergun = await recovery.createWithRecovery(config);

// Manual recovery
const stats = await lasergun.recoverFromBlockchain();
console.log(`Recovered ${stats.shieldsRecovered} shields`);
```

### Data Validation

```typescript
// Check data integrity
const validation = await lasergun.validateDataIntegrity();

if (!validation.isValid) {
  console.log('Issues found:', validation.issues);
  console.log('Suggestions:', validation.suggestions);
  
  // Auto-fix
  await lasergun.syncWithBlockchain();
}
```

### Emergency Recovery

```typescript
// Scan entire blockchain (use carefully - can be slow)
const result = await lasergun.emergencyRecovery(0); // from block 0

console.log(`Found ${result.shieldsFound} shields`);
console.log(`Created ${result.transactionsCreated} transactions`);
```

## 📊 Advanced Usage

### Real-time Balance from Blockchain

```typescript
// Always get fresh data from blockchain (bypasses localStorage)
const balance = await lasergun.getTokenBalanceFromBlockchain(tokenAddress);

console.log('Public balance:', balance.publicBalance);
console.log('Private balance:', balance.privateBalance);
console.log('Active shields:', balance.activeShields);
```

### Consolidate Multiple Shields

```typescript
// Get all shields for a token
const shields = await lasergun.getTokenShields(tokenAddress);
const secrets = shields.map(s => s.secret);

// Combine multiple shields into one
const result = await lasergun.consolidate(secrets, tokenAddress);

if (result.success) {
  console.log('Shields consolidated!');
  console.log('New commitment:', result.recipientCommitment);
}
```

### Event Monitoring

```typescript
// Listen for transactions
lasergun.onTransaction((transaction) => {
  console.log('New transaction:', transaction.type, transaction.amount);
});

// Listen for errors
lasergun.onError((error) => {
  console.error('Scanner error:', error.message);
});

// Listen for scanner state changes
lasergun.onStateChange((state) => {
  console.log('Scanner state:', state.isRunning, state.currentBlock);
});
```

## 🏗️ Architecture

### Core Components

- **LaserGun** - Main SDK class with all operations
- **EventScanner** - Automatic blockchain event monitoring
- **CryptoService** - ECIES encryption and key management
- **StorageAdapter** - Pluggable data storage (localStorage, custom)

### Data Flow

```
1. Shield:    Public Tokens → Private Commitment (stored on-chain)
2. Transfer:  Secret → ECIES Encrypted → Recipient Commitment  
3. Unshield:  Private Commitment → Public Tokens (to any address)
4. Recovery:  Blockchain Events → Deterministic Secret Generation
```

### Privacy Model

- **Commitments**: `keccak256(secret, recipient_address)`
- **Secrets**: `keccak256(private_key, nonce)` (deterministic)
- **Encryption**: ECIES for secret delivery to recipients
- **Unlinkability**: No connection between sender and recipient addresses

## 🔧 Configuration

### Storage Adapters

```typescript
import { LocalStorageAdapter } from '@lasergun-protocol/sdk';

// Built-in localStorage adapter
const storage = new LocalStorageAdapter();
const lasergun = new LaserGun(config, storage);

// Custom storage adapter
class CustomAdapter extends StorageAdapter {
  // Implement IStorageAdapter interface
  async saveTransaction(...) { /* your implementation */ }
  // ... other methods
}
```

### Scanner Configuration

```typescript
const scannerConfig = {
  startBlock: 18000000,    // Block to start scanning from
  batchSize: 5000         // Events to process per batch
};

const lasergun = new LaserGun(config, storage, scannerConfig);
```

### Network Configuration

```typescript
const config = {
  contractAddress: '0x...', // LaserGun contract
  chainId: 1,               // Ethereum mainnet
  provider: provider,       // ethers.js provider
  signer: signer,          // ethers.js signer
  signMessage: 'Custom'    // Optional: custom key derivation message
};
```

## 🛡️ Security

### Key Generation

- Keys are derived deterministically from wallet signatures
- Private keys never leave your device
- Each wallet generates unique ECIES keypairs per chain

### Privacy Guarantees

- **Sender Anonymity**: No link between your address and commitments
- **Recipient Privacy**: Only recipient can decrypt transfer secrets
- **Amount Privacy**: Transaction amounts are hidden from observers
- **Timing Privacy**: No correlation between shield and unshield operations

### Best Practices

```typescript
// Always validate data integrity periodically
setInterval(async () => {
  const validation = await lasergun.validateDataIntegrity();
  if (!validation.isValid) {
    await lasergun.syncWithBlockchain();
  }
}, 60000); // Every minute

// Use auto-recovery when suspicious of data loss
if (suspiciousActivity) {
  await lasergun.recoverFromBlockchain();
}

// Monitor your balances from blockchain directly
const freshBalance = await lasergun.getTokenBalanceFromBlockchain(token);
```

## 📱 Integration Examples

### React Hook

```typescript
import { useEffect, useState } from 'react';
import { LaserGun, recovery } from '@lasergun-protocol/sdk';

export function useLaserGun(config) {
  const [lasergun, setLaserGun] = useState<LaserGun | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function init() {
      try {
        const lg = await recovery.createWithRecovery(config);
        await lg.startScanner(true);
        setLaserGun(lg);
      } catch (error) {
        console.error('Failed to initialize LaserGun:', error);
      } finally {
        setIsLoading(false);
      }
    }
    
    init();
  }, []);

  return { lasergun, isLoading };
}
```

### Vue Composable

```typescript
import { ref, onMounted } from 'vue';
import { LaserGun, recovery } from '@lasergun-protocol/sdk';

export function useLaserGun(config) {
  const lasergun = ref<LaserGun | null>(null);
  const isLoading = ref(true);

  onMounted(async () => {
    try {
      lasergun.value = await recovery.createWithRecovery(config);
      await lasergun.value.startScanner(true);
    } catch (error) {
      console.error('Failed to initialize LaserGun:', error);
    } finally {
      isLoading.value = false;
    }
  });

  return { lasergun, isLoading };
}
```

## 🔍 Troubleshooting

### Common Issues

**"Scanner not initialized"**
```typescript
// Ensure you call initialize() before using scanner
await lasergun.initialize();
await lasergun.startScanner();
```

**"Recipient has not registered public key"**
```typescript
// Recipient needs to initialize LaserGun first
// This automatically registers their public key
await recipientLaserGun.initialize();
```

**"Data integrity issues"**
```typescript
// Check and fix data inconsistencies
const validation = await lasergun.validateDataIntegrity();
if (!validation.isValid) {
  await lasergun.syncWithBlockchain();
}
```

**"Missing shields after browser clear"**
```typescript
// Recover from blockchain
await lasergun.recoverFromBlockchain();

// Or use emergency recovery
await lasergun.emergencyRecovery(deploymentBlock);
```

### Performance Optimization

```typescript
// Use blockchain balance for critical operations
const balance = await lasergun.getTokenBalanceFromBlockchain(token);

// Cleanup spent shields periodically
await lasergun.cleanupSpentShields();

// Use smaller batch sizes for slower networks
const scannerConfig = { batchSize: 1000 };
```

## 📚 API Reference

### Core Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `shield(amount, token)` | Make tokens private | `Promise<ShieldResult>` |
| `unshield(secret, amount, recipient, token)` | Convert back to public | `Promise<UnshieldResult>` |
| `transfer(secret, amount, recipient, token)` | Anonymous transfer | `Promise<TransferResult>` |
| `consolidate(secrets, token)` | Combine multiple shields | `Promise<TransferResult>` |
| `getTokenBalance(token)` | Get public + private balance | `Promise<TokenBalance>` |

### Recovery Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `recoverFromBlockchain()` | Restore all data from blockchain | `Promise<RecoveryStats>` |
| `syncWithBlockchain()` | Sync local data with blockchain | `Promise<SyncStats>` |
| `validateDataIntegrity()` | Check data consistency | `Promise<ValidationResult>` |
| `emergencyRecovery(fromBlock)` | Full blockchain scan | `Promise<EmergencyStats>` |

### Utility Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `getTransactionHistory()` | All user transactions | `Promise<Transaction[]>` |
| `getUserShields()` | All user shields | `Promise<Shield[]>` |
| `getTokenShields(token)` | Shields for specific token | `Promise<Shield[]>` |
| `startScanner(autoRecover?)` | Start event monitoring | `Promise<void>` |
| `stopScanner()` | Stop event monitoring | `Promise<void>` |

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup

```bash
git clone https://github.com/lasergun-protocol/sdk
cd sdk
npm install
npm run build
npm test
```

### Running Tests

```bash
# Unit tests
npm test

# Integration tests (requires running node)
npm run test:integration

# Coverage
npm run test:coverage
```

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🔗 Links

- **Website**: [https://lasergun.xyz](https://lasergun.xyz)
- **Documentation**: [https://docs.lasergun.xyz](https://docs.lasergun.xyz)
- **Contract Repository**: [https://github.com/lasergun-protocol/contracts](https://github.com/lasergun-protocol/contracts)
- **Discord**: [https://discord.gg/lasergun](https://discord.gg/lasergun)
- **Twitter**: [@LaserGunProto](https://twitter.com/LaserGunProto)

---

**⚠️ Security Notice**: This is experimental software. Use at your own risk. Always verify contract addresses and test with small amounts first.