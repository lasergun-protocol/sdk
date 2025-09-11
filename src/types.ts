// Utility types
export type HexString = `0x${string}`;
export type Address = HexString;
export type BigNumberish = string | number | bigint;import type { Provider, Signer } from 'ethers';

// Import HD operation types from crypto module
export type HDOperation = 'shield' | 'remainder' | 'received' | 'consolidate';

// HD metadata base interface to avoid duplication
export interface HDMetadata {
  readonly derivationPath: string; // e.g. "shield/5", "remainder/2"
  readonly hdIndex: number; // Index within operation type (>= 0)
  readonly hdOperation: HDOperation; // Operation type
}

// Partial HD metadata for optional fields
export type PartialHDMetadata = Partial<HDMetadata>;

// Core configuration types
export interface LaserGunConfig {
  readonly contractAddress: string;
  readonly chainId: number;
  readonly provider: Provider;
  readonly signer: Signer;
  readonly signMessage?: string; // Custom message for key derivation
}

// Storage adapter interface
export interface IStorageAdapter {
  saveTransaction(chainId: number, wallet: string, nonce: number, transaction: Transaction): Promise<void>;
  loadTransactions(chainId: number, wallet: string): Promise<Transaction[]>;
  getTransaction(chainId: number, wallet: string, nonce: number): Promise<Transaction | null>;
  getLastNonce(chainId: number, wallet: string): Promise<number>;
  deleteWalletData(chainId: number, wallet: string): Promise<void>;
  
  // Crypto keys storage
  saveKeys(chainId: number, wallet: string, keys: CryptoKeys): Promise<void>;
  loadKeys(chainId: number, wallet: string): Promise<CryptoKeys | null>;
  
  // Shield management with HD support
  saveShield(chainId: number, wallet: string, shield: Shield): Promise<void>;
  loadShields(chainId: number, wallet: string): Promise<Shield[]>;
  getShield(chainId: number, wallet: string, commitment: string): Promise<Shield | null>;
  deleteShield(chainId: number, wallet: string, commitment: string): Promise<void>;
  
  // Scanner state
  saveLastScannedBlock(chainId: number, wallet: string, blockNumber: number): Promise<void>;
  getLastScannedBlock(chainId: number, wallet: string): Promise<number | null>;
  
  // HD derivation tracking
  saveEventCounts(chainId: number, wallet: string, counts: EventCounts): Promise<void>;
  loadEventCounts(chainId: number, wallet: string): Promise<EventCounts | null>;
}

// Abstract base class for storage adapters
export abstract class StorageAdapter implements IStorageAdapter {
  abstract saveTransaction(chainId: number, wallet: string, nonce: number, transaction: Transaction): Promise<void>;
  abstract loadTransactions(chainId: number, wallet: string): Promise<Transaction[]>;
  abstract getTransaction(chainId: number, wallet: string, nonce: number): Promise<Transaction | null>;
  abstract getLastNonce(chainId: number, wallet: string): Promise<number>;
  abstract deleteWalletData(chainId: number, wallet: string): Promise<void>;
  abstract saveKeys(chainId: number, wallet: string, keys: CryptoKeys): Promise<void>;
  abstract loadKeys(chainId: number, wallet: string): Promise<CryptoKeys | null>;
  abstract saveShield(chainId: number, wallet: string, shield: Shield): Promise<void>;
  abstract loadShields(chainId: number, wallet: string): Promise<Shield[]>;
  abstract getShield(chainId: number, wallet: string, commitment: string): Promise<Shield | null>;
  abstract deleteShield(chainId: number, wallet: string, commitment: string): Promise<void>;
  abstract saveLastScannedBlock(chainId: number, wallet: string, blockNumber: number): Promise<void>;
  abstract getLastScannedBlock(chainId: number, wallet: string): Promise<number | null>;
  abstract saveEventCounts(chainId: number, wallet: string, counts: EventCounts): Promise<void>;
  abstract loadEventCounts(chainId: number, wallet: string): Promise<EventCounts | null>;
}

// Transaction types with HD support
export interface Transaction extends PartialHDMetadata {
  readonly nonce: number;
  readonly type: TransactionType;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly timestamp: number;
  readonly token: string;
  readonly amount: string; // BigInt as string
  readonly commitment?: string;
  readonly from?: string; // 
  readonly to?: string;
  readonly fee?: string;
}

// Add 'consolidate' and 'remainder' to TransactionType if not present
export type TransactionType = 'shield' | 'unshield' | 'transfer' | 'received' | 'remainder' | 'consolidate';
// Event counting for HD derivation with constraints
export interface EventCounts {
  readonly shield: number; // Count of shield operations (>= 0)
  readonly remainder: number; // Count of remainder operations (>= 0)
  readonly received: number; // Count of received transfers (>= 0)
  readonly consolidate: number; // Count of consolidation operations (>= 0)
  readonly lastUpdatedBlock: number; // Last block where counts were updated (> 0)
}

// Utility type for creating valid EventCounts
export type CreateEventCounts = {
  readonly shield?: number;
  readonly remainder?: number;
  readonly received?: number;
  readonly consolidate?: number;
  readonly lastUpdatedBlock: number;
};

// Crypto types
export interface CryptoKeys {
  readonly privateKey: string; // hex string
  readonly publicKey: string; // hex string
  readonly keyNonce: number; // for deterministic generation
}

// Balance types
export interface TokenBalance {
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly publicBalance: string; // BigInt as string
  readonly privateBalance: string; // BigInt as string
}

// Shield types with HD derivation support
export interface Shield extends PartialHDMetadata {
  readonly secret: string; // hex string
  readonly commitment: string; // hex string
  readonly token: string;
  readonly amount: string; // BigInt as string
  readonly timestamp: number;
  readonly txHash?: string; // Transaction hash for correlation
  readonly blockNumber?: number; // Block number when created
}

// HD Derivation result type
export interface HDDerivationResult extends HDMetadata {
  readonly secret: string; // Generated secret
  readonly commitment: string; // Generated commitment
}

// Event scanner types
export interface ScannerConfig {
  readonly startBlock?: number;
  readonly batchSize?: number;
  readonly enableHDRecovery?: boolean; // Enable HD-based recovery (default: true)
  readonly maxHDIndex?: number; // Maximum HD index to check during recovery (default: 1000)
}

export interface ScannerState {
  readonly isRunning: boolean;
  readonly currentBlock: number;
  readonly lastScannedBlock: number;
  readonly chainId: number;
  readonly wallet: string;
  readonly eventCounts?: EventCounts; // Current event counts for HD derivation
}

// Operation result types with HD support
export interface OperationResult {
  readonly success: boolean;
  readonly txHash?: string;
  readonly error?: LaserGunError;
  readonly derivationPath?: string; // HD path used for this operation
}

export interface ShieldResult extends OperationResult {
  readonly commitment?: string;
  readonly netAmount?: string;
  readonly fee?: string;
  readonly hdIndex?: number;
}

export interface UnshieldResult extends OperationResult {
  readonly amount?: string;
  readonly fee?: string;
  readonly remainderCommitment?: string;
  readonly remainderDerivationPath?: string; // HD path for remainder shield
}

export interface TransferResult extends OperationResult {
  readonly recipientCommitment?: string;
  readonly remainderCommitment?: string;
  readonly remainderDerivationPath?: string; // HD path for remainder
  readonly amount?: string;
}

// HD Recovery result type
export interface HDRecoveryResult {
  readonly shieldsRecovered: number;
  readonly transactionsCreated: number;
  readonly eventCounts: EventCounts;
  readonly derivationPaths: string[]; // All paths that were found
  readonly errors: string[];
}

// Error types
export class LaserGunError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'LaserGunError';
  }
}

export enum ErrorCode {
  INVALID_CONFIG = 'INVALID_CONFIG',
  NETWORK_ERROR = 'NETWORK_ERROR',
  CONTRACT_ERROR = 'CONTRACT_ERROR',
  CRYPTO_ERROR = 'CRYPTO_ERROR',
  STORAGE_ERROR = 'STORAGE_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  INVALID_AMOUNT = 'INVALID_AMOUNT',
  SCANNER_ERROR = 'SCANNER_ERROR',
  COMMITMENT_EXISTS = 'COMMITMENT_EXISTS',
  SHIELD_NOT_FOUND = 'SHIELD_NOT_FOUND',
  HD_DERIVATION_ERROR = 'HD_DERIVATION_ERROR', // HD-specific errors
  EVENT_COUNT_ERROR = 'EVENT_COUNT_ERROR' // Event counting errors
}

// Event callbacks
export type TransactionCallback = (transaction: Transaction) => void;
export type ErrorCallback = (error: LaserGunError) => void;
export type StateChangeCallback = (state: ScannerState) => void;
export type ScannedBlockCallback = (blockId: number) => void;
export type HDRecoveryCallback = (result: HDRecoveryResult) => void;

// Contract event types (matching smart contract events)
export interface ShieldedEvent {
  readonly commitment: string;
  readonly token: string;
  readonly amount: string;
  readonly fee: string;
  readonly blockNumber: number;
  readonly txHash: string;
  readonly timestamp?: number;
}

export interface UnshieldedEvent {
  readonly commitment: string;
  readonly token: string;
  readonly amount: string;
  readonly fee: string;
  readonly blockNumber: number;
  readonly txHash: string;
  readonly timestamp?: number;
}

export interface SecretDeliveredEvent {
  readonly encryptedSecret: string;
  readonly blockNumber: number;
  readonly txHash: string;
  readonly timestamp?: number;
}

// Note: ShieldConsolidated event has indexed array which becomes hash
// We need to parse transaction data to get actual oldCommitments
export interface ShieldConsolidatedEvent {
  readonly oldCommitmentsHash: string; // keccak256 hash of oldCommitments array
  readonly newCommitment: string;
  readonly blockNumber: number;
  readonly txHash: string;
  readonly timestamp?: number;
  // Actual data must be parsed from transaction input data
  readonly actualOldCommitments?: string[]; // Parsed from tx data if available
}

// HD Derivation specific types
export interface EventCountUpdate {
  readonly operation: HDOperation; // HD operation type
  readonly previousCount: number;
  readonly newCount: number;
  readonly blockNumber: number;
  readonly reason: string; // Why count was updated
}

// Simplified recovery options - focused on primary use cases
export interface RecoveryOptions {
  readonly useEventCounting: boolean; // Use event-driven counting (recommended: true)
  readonly maxBruteForceIndex: number; // Maximum index for fallback search (default: 100)
  readonly batchSize: number; // Batch size for recovery operations (default: 50)
  readonly verifyOnChain: boolean; // Verify each found shield on-chain (default: true)
}

// Recovery progress tracking
export interface RecoveryProgress {
  readonly currentOperation: HDOperation; // Current operation being recovered
  readonly currentIndex: number; // Current index being checked
  readonly totalFound: number; // Total shields found so far
  readonly estimatedTotal?: number; // Estimated total (from event counts)
  readonly percentage?: number; // Recovery percentage (0-100)
}

// Utility functions for EventCounts validation
export const createEventCounts = (data: CreateEventCounts): EventCounts => {
  const validateCount = (count: number, name: string): number => {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`${name} count must be a non-negative integer, got: ${count}`);
    }
    return count;
  };

  if (data.lastUpdatedBlock <= 0) {
    throw new Error(`lastUpdatedBlock must be positive, got: ${data.lastUpdatedBlock}`);
  }

  return {
    shield: validateCount(data.shield ?? 0, 'shield'),
    remainder: validateCount(data.remainder ?? 0, 'remainder'),
    received: validateCount(data.received ?? 0, 'received'),
    consolidate: validateCount(data.consolidate ?? 0, 'consolidate'),
    lastUpdatedBlock: data.lastUpdatedBlock
  };
};

// Utility function for creating default RecoveryOptions
export const createRecoveryOptions = (options: Partial<RecoveryOptions> = {}): RecoveryOptions => ({
  useEventCounting: options.useEventCounting ?? true,
  maxBruteForceIndex: options.maxBruteForceIndex ?? 100,
  batchSize: options.batchSize ?? 50,
  verifyOnChain: options.verifyOnChain ?? true
});