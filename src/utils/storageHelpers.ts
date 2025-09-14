import type { IStorageAdapter, Shield, Transaction, EventCounts } from '../types';
import { ErrorHelpers } from './errorHelpers'; 

/**
 * Storage operation helpers with common patterns and error handling
 * Provides consistent storage operations across all modules
 */
export class StorageHelpers {

  /**
   * Get storage context (chainId, wallet) helper
   */
  static getStorageContext(chainId: number, wallet: string): { chainId: number; wallet: string } {
    return { chainId, wallet };
  }

  /**
   * Save shield with error handling
   */
  static async saveShield(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string,
    shield: Shield
  ): Promise<void> {
    try {
      await storage.saveShield(chainId, wallet, shield);
    } catch (error) {
      throw ErrorHelpers.storageError(
        `save shield ${shield.commitment.slice(0, 10)}...`,
        ErrorHelpers.getErrorMessage(error)
      );
    }
  }

  /**
   * Save transaction with error handling
   */
  static async saveTransaction(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string,
    transaction: Transaction
  ): Promise<void> {
    try {
      await storage.saveTransaction(chainId, wallet, transaction.nonce, transaction);
    } catch (error) {
      throw ErrorHelpers.storageError(
        `save transaction ${transaction.txHash}`,
        ErrorHelpers.getErrorMessage(error)
      );
    }
  }

  /**
   * Save event counts with error handling
   */
  static async saveEventCounts(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string,
    eventCounts: EventCounts
  ): Promise<void> {
    try {
      await storage.saveEventCounts(chainId, wallet, eventCounts);
    } catch (error) {
      throw ErrorHelpers.storageError(
        'save event counts',
        ErrorHelpers.getErrorMessage(error)
      );
    }
  }

  /**
   * Load shields with error handling and validation
   */
  static async loadShields(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string
  ): Promise<Shield[]> {
    try {
      const shields = await storage.loadShields(chainId, wallet);
      return StorageHelpers.validateShields(shields);
    } catch (error) {
      throw ErrorHelpers.storageError(
        'load shields',
        ErrorHelpers.getErrorMessage(error)
      );
    }
  }

  /**
   * Load transactions with error handling and validation
   */
  static async loadTransactions(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string
  ): Promise<Transaction[]> {
    try {
      const transactions = await storage.loadTransactions(chainId, wallet);
      return StorageHelpers.validateTransactions(transactions);
    } catch (error) {
      throw ErrorHelpers.storageError(
        'load transactions',
        ErrorHelpers.getErrorMessage(error)
      );
    }
  }

  /**
   * Load event counts with fallback to default
   */
  static async loadEventCounts(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string,
    createDefault: boolean = true
  ): Promise<EventCounts | null> {
    try {
      const counts = await storage.loadEventCounts(chainId, wallet);
      
      if (!counts && createDefault) {
        return {
          shield: 0,
          remainder: 0,
          received: 0,
          consolidate: 0,
          lastUpdatedBlock: 0
        };
      }
      
      return counts;
    } catch (error) {
      if (createDefault) {
        console.warn('Failed to load event counts, using defaults:', error);
        return {
          shield: 0,
          remainder: 0,
          received: 0,
          consolidate: 0,
          lastUpdatedBlock: 0
        };
      }
      
      throw ErrorHelpers.storageError(
        'load event counts',
        ErrorHelpers.getErrorMessage(error)
      );
    }
  }

  /**
   * Get shield by commitment with error handling
   */
  static async getShield(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string,
    commitment: string
  ): Promise<Shield | null> {
    try {
      return await storage.getShield(chainId, wallet, commitment);
    } catch (error) {
      throw ErrorHelpers.storageError(
        `get shield ${commitment.slice(0, 10)}...`,
        ErrorHelpers.getErrorMessage(error)
      );
    }
  }

  /**
   * Batch save shields with partial success handling
   */
  static async batchSaveShields(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string,
    shields: Shield[]
  ): Promise<{
    saved: number;
    failed: number;
    errors: Array<{ shield: string; error: string }>;
  }> {
    let saved = 0;
    let failed = 0;
    const errors: Array<{ shield: string; error: string }> = [];

    for (const shield of shields) {
      try {
        await StorageHelpers.saveShield(storage, chainId, wallet, shield);
        saved++;
      } catch (error) {
        failed++;
        errors.push({
          shield: shield.commitment.slice(0, 10) + '...',
          error: ErrorHelpers.getErrorMessage(error)
        });
      }
    }

    return { saved, failed, errors };
  }

  /**
   * Batch save transactions with partial success handling
   */
  static async batchSaveTransactions(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string,
    transactions: Transaction[]
  ): Promise<{
    saved: number;
    failed: number;
    errors: Array<{ txHash: string; error: string }>;
  }> {
    let saved = 0;
    let failed = 0;
    const errors: Array<{ txHash: string; error: string }> = [];

    for (const transaction of transactions) {
      try {
        await StorageHelpers.saveTransaction(storage, chainId, wallet, transaction);
        saved++;
      } catch (error) {
        failed++;
        errors.push({
          txHash: transaction.txHash,
          error: ErrorHelpers.getErrorMessage(error)
        });
      }
    }

    return { saved, failed, errors };
  }

  /**
   * Validate shields array
   */
  private static validateShields(shields: Shield[]): Shield[] {
    return shields.filter(shield => {
      if (!shield.commitment || !shield.secret || !shield.token) {
        console.warn('Invalid shield found, skipping:', shield);
        return false;
      }
      return true;
    });
  }

  /**
   * Validate transactions array
   */
  private static validateTransactions(transactions: Transaction[]): Transaction[] {
    return transactions.filter(tx => {
      if (!tx.txHash || !tx.token || tx.nonce === undefined) {
        console.warn('Invalid transaction found, skipping:', tx);
        return false;
      }
      return true;
    });
  }

  /**
   * Clear wallet data with error handling
   */
  static async clearWalletData(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string
  ): Promise<void> {
    try {
      await storage.deleteWalletData(chainId, wallet);
    } catch (error) {
      throw ErrorHelpers.storageError(
        'clear wallet data',
        ErrorHelpers.getErrorMessage(error)
      );
    }
  }

  /**
   * Get last scanned block with fallback
   */
  static async getLastScannedBlock(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string,
    defaultBlock: number = 0
  ): Promise<number> {
    try {
      const lastBlock = await storage.getLastScannedBlock(chainId, wallet);
      return lastBlock ?? defaultBlock;
    } catch (error) {
      console.warn('Failed to get last scanned block, using default:', error);
      return defaultBlock;
    }
  }

  /**
   * Save last scanned block with error handling
   */
  static async saveLastScannedBlock(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string,
    blockNumber: number
  ): Promise<void> {
    try {
      await storage.saveLastScannedBlock(chainId, wallet, blockNumber);
    } catch (error) {
      throw ErrorHelpers.storageError(
        `save last scanned block ${blockNumber}`,
        ErrorHelpers.getErrorMessage(error)
      );
    }
  }

  /**
   * Check if shield exists
   */
  static async shieldExists(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string,
    commitment: string
  ): Promise<boolean> {
    try {
      const shield = await storage.getShield(chainId, wallet, commitment);
      return shield !== null;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get storage statistics
   */
  static async getStorageStats(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string
  ): Promise<{
    shieldsCount: number;
    transactionsCount: number;
    lastScannedBlock: number | null;
    hasEventCounts: boolean;
  }> {
    try {
      const [shields, transactions, lastBlock, eventCounts] = await Promise.all([
        storage.loadShields(chainId, wallet),
        storage.loadTransactions(chainId, wallet),
        storage.getLastScannedBlock(chainId, wallet),
        storage.loadEventCounts(chainId, wallet)
      ]);

      return {
        shieldsCount: shields.length,
        transactionsCount: transactions.length,
        lastScannedBlock: lastBlock,
        hasEventCounts: eventCounts !== null
      };
    } catch (error) {
      throw ErrorHelpers.storageError(
        'get storage statistics',
        ErrorHelpers.getErrorMessage(error)
      );
    }
  }
}