import type { Transaction, CryptoKeys, Shield } from '../types';
import { StorageAdapter, LaserGunError, ErrorCode } from '../types';

/**
 * LocalStorage implementation of StorageAdapter
 * Stores data by chainId and wallet address for multi-network/multi-wallet support
 * 
 * Note: Requires browser environment with localStorage API
 */
export class LocalStorageAdapter extends StorageAdapter {
  private readonly keyPrefix = 'lasergun';

  constructor() {
    super();
    // Check if localStorage is available
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      throw new LaserGunError(
        'localStorage is not available in this environment',
        ErrorCode.STORAGE_ERROR
      );
    }
  }

  /**
   * Generate storage key
   */
  private getKey(chainId: number, wallet: string, type: string, id?: string | number): string {
    const baseKey = `${this.keyPrefix}_${chainId}_${wallet.toLowerCase()}_${type}`;
    return id !== undefined ? `${baseKey}_${id}` : baseKey;
  }

  /**
   * Safe localStorage operations with error handling
   */
  private setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      throw new LaserGunError(
        `Failed to write to localStorage: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }

  private getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      throw new LaserGunError(
        `Failed to read from localStorage: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }

  private removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      throw new LaserGunError(
        `Failed to remove from localStorage: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }

  /**
   * Save transaction to localStorage
   */
  async saveTransaction(chainId: number, wallet: string, nonce: number, transaction: Transaction): Promise<void> {
    const key = this.getKey(chainId, wallet, 'tx', nonce);
    const data = JSON.stringify(transaction);
    this.setItem(key, data);
  }

  /**
   * Load all transactions for wallet/chain
   */
  async loadTransactions(chainId: number, wallet: string): Promise<Transaction[]> {
    const transactions: Transaction[] = [];
    const prefix = this.getKey(chainId, wallet, 'tx');

    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith(prefix + '_')) {
          const data = this.getItem(key);
          if (data) {
            const transaction = JSON.parse(data) as Transaction;
            transactions.push(transaction);
          }
        }
      }

      // Sort by nonce for consistent ordering
      return transactions.sort((a, b) => a.nonce - b.nonce);
    } catch (error) {
      throw new LaserGunError(
        `Failed to load transactions: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }

  /**
   * Get specific transaction by nonce
   */
  async getTransaction(chainId: number, wallet: string, nonce: number): Promise<Transaction | null> {
    const key = this.getKey(chainId, wallet, 'tx', nonce);
    const data = this.getItem(key);
    
    if (!data) {
      return null;
    }

    try {
      return JSON.parse(data) as Transaction;
    } catch (error) {
      throw new LaserGunError(
        `Failed to parse transaction data: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }

  /**
   * Get highest nonce for wallet/chain
   */
  async getLastNonce(chainId: number, wallet: string): Promise<number> {
    const transactions = await this.loadTransactions(chainId, wallet);
    
    if (transactions.length === 0) {
      return 0;
    }

    return Math.max(...transactions.map(tx => tx.nonce));
  }

  /**
   * Delete all data for wallet/chain
   */
  async deleteWalletData(chainId: number, wallet: string): Promise<void> {
    const prefix = this.getKey(chainId, wallet, '');
    const keysToDelete: string[] = [];

    try {
      // Collect all keys to delete
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith(prefix)) {
          keysToDelete.push(key);
        }
      }

      // Delete collected keys
      keysToDelete.forEach(key => this.removeItem(key));
    } catch (error) {
      throw new LaserGunError(
        `Failed to delete wallet data: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }

  /**
   * Save ECIES keys for wallet/chain
   */
  async saveKeys(chainId: number, wallet: string, keys: CryptoKeys): Promise<void> {
    const key = this.getKey(chainId, wallet, 'keys');
    const data = JSON.stringify(keys);
    this.setItem(key, data);
  }

  /**
   * Load ECIES keys for wallet/chain
   */
  async loadKeys(chainId: number, wallet: string): Promise<CryptoKeys | null> {
    const key = this.getKey(chainId, wallet, 'keys');
    const data = this.getItem(key);
    
    if (!data) {
      return null;
    }

    try {
      return JSON.parse(data) as CryptoKeys;
    } catch (error) {
      throw new LaserGunError(
        `Failed to parse keys data: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }

  /**
   * Save last scanned block number
   */
  async saveLastScannedBlock(chainId: number, wallet: string, blockNumber: number): Promise<void> {
    const key = this.getKey(chainId, wallet, 'lastBlock');
    this.setItem(key, blockNumber.toString());
  }

  /**
   * Get last scanned block number
   */
  async getLastScannedBlock(chainId: number, wallet: string): Promise<number | null> {
    const key = this.getKey(chainId, wallet, 'lastBlock');
    const data = this.getItem(key);
    
    if (!data) {
      return null;
    }

    const blockNumber = parseInt(data, 10);
    if (isNaN(blockNumber)) {
      throw new LaserGunError(
        'Invalid block number in storage',
        ErrorCode.STORAGE_ERROR
      );
    }

    return blockNumber;
  }

  /**
   * Save shield to localStorage
   */
  async saveShield(chainId: number, wallet: string, shield: Shield): Promise<void> {
    const key = this.getKey(chainId, wallet, 'shield', shield.commitment);
    const data = JSON.stringify(shield);
    this.setItem(key, data);
  }

  /**
   * Load all shields for wallet/chain
   */
  async loadShields(chainId: number, wallet: string): Promise<Shield[]> {
    const shields: Shield[] = [];
    const prefix = this.getKey(chainId, wallet, 'shield');

    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith(prefix + '_')) {
          const data = this.getItem(key);
          if (data) {
            const shield = JSON.parse(data) as Shield;
            shields.push(shield);
          }
        }
      }

      // Sort by timestamp for consistent ordering
      return shields.sort((a, b) => a.timestamp - b.timestamp);
    } catch (error) {
      throw new LaserGunError(
        `Failed to load shields: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }

  /**
   * Get specific shield by commitment
   */
  async getShield(chainId: number, wallet: string, commitment: string): Promise<Shield | null> {
    const key = this.getKey(chainId, wallet, 'shield', commitment);
    const data = this.getItem(key);
    
    if (!data) {
      return null;
    }

    try {
      return JSON.parse(data) as Shield;
    } catch (error) {
      throw new LaserGunError(
        `Failed to parse shield data: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }

  /**
   * Delete specific shield
   */
  async deleteShield(chainId: number, wallet: string, commitment: string): Promise<void> {
    const key = this.getKey(chainId, wallet, 'shield', commitment);
    this.removeItem(key);
  }
  async clearAll(): Promise<void> {
    const keysToDelete: string[] = [];

    try {
      // Collect all LaserGun keys
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith(this.keyPrefix + '_')) {
          keysToDelete.push(key);
        }
      }

      // Delete all collected keys
      keysToDelete.forEach(key => this.removeItem(key));
    } catch (error) {
      throw new LaserGunError(
        `Failed to clear all data: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }

  /**
   * Get storage usage statistics
   */
  async getStorageStats(chainId?: number, wallet?: string): Promise<{
    totalKeys: number;
    totalSize: number;
    transactionCount: number;
  }> {
    let totalKeys = 0;
    let totalSize = 0;
    let transactionCount = 0;

    try {
      const filterPrefix = chainId && wallet 
        ? this.getKey(chainId, wallet, '')
        : this.keyPrefix + '_';

      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith(filterPrefix)) {
          totalKeys++;
          const value = this.getItem(key);
          if (value) {
            totalSize += key.length + value.length;
            if (key.includes('_tx_')) {
              transactionCount++;
            }
          }
        }
      }

      return { totalKeys, totalSize, transactionCount };
    } catch (error) {
      throw new LaserGunError(
        `Failed to get storage stats: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }
}