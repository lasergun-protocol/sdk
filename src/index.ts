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
   * Create LaserGun instance with localStorage adapter
   */
  createWithLocalStorage: (config: LaserGunConfig, scannerConfig?: ScannerConfig) => {
    const storage = new LocalStorageAdapter();
    return new LaserGun(config, storage, scannerConfig);
  }
};