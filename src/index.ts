import { LocalStorageAdapter } from './adapters/localStorage';
import LaserGun from './core/lasergun';
import { CryptoService } from './crypto';
import { LaserGunConfig, ScannerConfig } from './types';

// Main LaserGun SDK export
export { default as LaserGun } from './core/lasergun';
export { default } from './core/lasergun';

// Core modules
export { EventScanner } from './core/scanner';
export { CryptoService } from './crypto';

// Storage adapters
export { LocalStorageAdapter } from './adapters/localStorage';

// Type definitions
export type {
  // Configuration
  LaserGunConfig,
  ScannerConfig,
  
  // Storage
  IStorageAdapter,
  
  // Crypto
  CryptoKeys,
  Shield,
  
  // Transactions
  Transaction,
  TransactionType,
  
  // Results
  OperationResult,
  ShieldResult,
  UnshieldResult,
  TransferResult,
  
  // Balances
  TokenBalance,
  
  // Scanner
  ScannerState,
  
  // Events
  ShieldedEvent,
  UnshieldedEvent,
  SecretDeliveredEvent,
  
  // Callbacks
  TransactionCallback,
  ErrorCallback,
  StateChangeCallback,
  
  // Utility types
  HexString,
  Address,
  BigNumberish,

  StorageAdapter
} from './types';

// Error handling
export { LaserGunError, ErrorCode } from './types';

// Version info
export const VERSION = '1.0.0';

// Recovery and diagnostic utilities
export const recovery = {
  /**
   * Create LaserGun instance and immediately recover from blockchain
   */
  createWithRecovery: async (config: LaserGunConfig, scannerConfig?: ScannerConfig) => {
    const storage = new LocalStorageAdapter();
    const lasergun = new LaserGun(config, storage, scannerConfig);
    await lasergun.initialize();
    
    // Automatically recover any missing data
    const recoveryResult = await lasergun.recoverFromBlockchain();
    console.log(`Recovered ${recoveryResult.shieldsRecovered} shields and ${recoveryResult.transactionsRecovered} transactions`);
    
    return lasergun;
  },
  
  /**
   * Perform emergency recovery for existing LaserGun instance
   */
  emergencyRecover: async (lasergun: LaserGun, fromBlock: number = 0) => {
    return await lasergun.emergencyRecovery(fromBlock);
  },
  
  /**
   * Validate data integrity for LaserGun instance
   */
  validateIntegrity: async (lasergun: LaserGun) => {
    return await lasergun.validateDataIntegrity();
  },
  
  /**
   * Sync local storage with blockchain for LaserGun instance
   */
  syncWithBlockchain: async (lasergun: LaserGun) => {
    return await lasergun.syncWithBlockchain();
  }
};

// Utility functions for common operations
export const utils = {
  /**
   * Check if string is valid hex format
   */
  isValidHexString: CryptoService.isValidHexString,
  
  /**
   * Check if string is valid Ethereum address
   */
  isValidAddress: CryptoService.isValidAddress,
  
  /**
   * Generate commitment from secret and recipient
   */
  generateCommitment: CryptoService.generateCommitment,
  
  /**
   * Generate deterministic secret from private key and nonce
   */
  generateSecret: CryptoService.generateSecret,
  
  /**
   * Create LaserGun instance with localStorage adapter
   */
  createWithLocalStorage: (config: LaserGunConfig, scannerConfig?: ScannerConfig) => {
    const storage = new LocalStorageAdapter();
    return new LaserGun(config, storage, scannerConfig);
  },
  
  /**
   * Create LaserGun instance with automatic data validation
   */
  createWithValidation: async (config: LaserGunConfig, scannerConfig?: ScannerConfig) => {
    const storage = new LocalStorageAdapter();
    const lasergun = new LaserGun(config, storage, scannerConfig);
    await lasergun.initialize();
    
    // Validate data integrity
    const validation = await lasergun.validateDataIntegrity();
    
    if (!validation.isValid) {
      console.warn('Data integrity issues found:', validation.issues);
      console.log('Suggestions:', validation.suggestions);
      
      // Auto-sync if there are issues
      const syncResult = await lasergun.syncWithBlockchain();
      console.log(`Auto-sync completed: +${syncResult.added}, -${syncResult.removed}, ~${syncResult.updated}`);
    }
    
    return lasergun;
  }
};

// Diagnostic utilities
export const diagnostics = {
  /**
   * Get comprehensive diagnostic info for LaserGun instance
   */
  getDiagnostics: async (lasergun: LaserGun) => {
    const scannerState = lasergun.getScannerState();
    const validation = await lasergun.validateDataIntegrity();
    const transactions = await lasergun.getTransactionHistory();
    const shields = await lasergun.getUserShields();
    
    return {
      scanner: scannerState,
      validation,
      transactionCount: transactions.length,
      shieldCount: shields.length,
      wallet: lasergun.getWallet(),
      publicKey: lasergun.getPublicKey()
    };
  },
   
  /**
   * Clear all data for wallet/chain
   */
  clearWalletData: async (chainId: number, wallet: string) => {
    const storage = new LocalStorageAdapter();
    await storage.deleteWalletData(chainId, wallet);
  },
  
  /**
   * Clear all LaserGun data
   */
  clearAllData: async () => {
    const storage = new LocalStorageAdapter();
    await storage.clearAll();
  }
};

// Best practices examples
export const examples = {
  /**
   * Recommended initialization pattern
   */
  init: `
// Recommended initialization with auto-recovery
import { recovery } from '@lasergun/sdk';

const lasergun = await recovery.createWithRecovery({
  contractAddress: '0x...',
  chainId: 1,
  provider: provider,
  signer: signer
});

// Start scanning for new events
await lasergun.startScanner();
`,

  /**
   * Safe shield operation pattern
   */
  shield: `
// Always check balance from blockchain for accuracy
const balance = await lasergun.getTokenBalanceFromBlockchain(tokenAddress);
console.log('Current private balance:', balance.privateBalance);

const result = await lasergun.shield('100', tokenAddress);
if (result.success) {
  console.log('Shield created:', result.commitment);
} else {
  console.error('Shield failed:', result.error);
}
`,

  /**
   * Recovery after data loss pattern
   */
  recovery: `
// If you suspect data loss
const validation = await diagnostics.validateIntegrity(lasergun);

if (!validation.isValid) {
  console.log('Issues found:', validation.issues);
  
  // Try sync first (faster)
  await recovery.syncWithBlockchain(lasergun);
  
  // If still issues, do emergency recovery
  if (stillHaveIssues) {
    await recovery.emergencyRecover(lasergun, 0);
  }
}
`
};