import type { Provider, Signer } from 'ethers';

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
  
  // Shield management
  saveShield(chainId: number, wallet: string, shield: Shield): Promise<void>;
  loadShields(chainId: number, wallet: string): Promise<Shield[]>;
  getShield(chainId: number, wallet: string, commitment: string): Promise<Shield | null>;
  deleteShield(chainId: number, wallet: string, commitment: string): Promise<void>;
  
  // Scanner state
  saveLastScannedBlock(chainId: number, wallet: string, blockNumber: number): Promise<void>;
  getLastScannedBlock(chainId: number, wallet: string): Promise<number | null>;
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
}

// Transaction types
export interface Transaction {
  readonly nonce: number;
  readonly type: TransactionType;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly timestamp: number;
  readonly token: string;
  readonly amount: string; // BigInt as string
  readonly commitment?: string;
  readonly from?: string;
  readonly to?: string;
  readonly fee?: string;
}

export type TransactionType = 'shield' | 'unshield' | 'transfer' | 'received';

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

// Shield types
export interface Shield {
  readonly secret: string; // hex string
  readonly commitment: string; // hex string
  readonly token: string;
  readonly amount: string; // BigInt as string
  readonly timestamp: number;
}

// Event scanner types
export interface ScannerConfig {
  readonly startBlock?: number;
  readonly batchSize?: number;
}

export interface ScannerState {
  readonly isRunning: boolean;
  readonly currentBlock: number;
  readonly lastScannedBlock: number;
  readonly chainId: number;
  readonly wallet: string;
}

// Operation result types
export interface OperationResult {
  readonly success: boolean;
  readonly txHash?: string;
  readonly error?: LaserGunError;
}

export interface ShieldResult extends OperationResult {
  readonly commitment?: string;
  readonly netAmount?: string;
  readonly fee?: string;
}

export interface UnshieldResult extends OperationResult {
  readonly amount?: string;
  readonly fee?: string;
  readonly remainderCommitment?: string;
}

export interface TransferResult extends OperationResult {
  readonly recipientCommitment?: string;
  readonly remainderCommitment?: string;
  readonly amount?: string;
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
  SHIELD_NOT_FOUND = 'SHIELD_NOT_FOUND'
}

// Event callbacks
export type TransactionCallback = (transaction: Transaction) => void;
export type ErrorCallback = (error: LaserGunError) => void;
export type StateChangeCallback = (state: ScannerState) => void;

// Contract event types (matching smart contract events)
export interface ShieldedEvent {
  readonly commitment: string;
  readonly token: string;
  readonly amount: string;
  readonly fee: string;
  readonly blockNumber: number;
  readonly txHash: string;
}

export interface UnshieldedEvent {
  readonly commitment: string;
  readonly token: string;
  readonly amount: string;
  readonly fee: string;
  readonly blockNumber: number;
  readonly txHash: string;
}

export interface SecretDeliveredEvent {
  readonly encryptedSecret: string;
  readonly blockNumber: number;
  readonly txHash: string;
}

// Utility types
export type HexString = `0x${string}`;
export type Address = HexString;
export type BigNumberish = string | number | bigint;