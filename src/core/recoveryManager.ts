import type { IStorageAdapter,  EventCounts } from '../types';
import { LaserGunError, ErrorCode } from '../types';
import { LaserGunConfigManager } from './config';
import { EventScanner } from './scanner';

/**
 * Recovery and synchronization manager
 * Handles blockchain recovery, data integrity validation, and synchronization
 */
export class RecoveryManager {
  private readonly configManager: LaserGunConfigManager;
  private readonly storage: IStorageAdapter;
  private readonly scanner: EventScanner;

  constructor(
    configManager: LaserGunConfigManager,
    storage: IStorageAdapter,
    scanner: EventScanner
  ) {
    this.configManager = configManager;
    this.storage = storage;
    this.scanner = scanner;
  }

  /**
   * Recover all data from blockchain using HD scanner
   */
  async recoverFromBlockchain(): Promise<{
    shieldsRecovered: number;
    transactionsRecovered: number;
  }> {
    try {
      await this.configManager.checkNetworkConnection();
      
      // Use scanner's HD recovery mechanism
      await this.scanner.recoverFromBlockchain();
      
      // Get counts for reporting
      const shields = await this.storage.loadShields(
        this.configManager.getConfig().chainId, 
        this.configManager.getWallet()
      );
      const transactions = await this.storage.loadTransactions(
        this.configManager.getConfig().chainId, 
        this.configManager.getWallet()
      );
      
      return {
        shieldsRecovered: shields.length,
        transactionsRecovered: transactions.length
      };
      
    } catch (error) {
      throw new LaserGunError(
        `Failed to recover from blockchain: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.SCANNER_ERROR,
        error
      );
    }
  }

  /**
   * Emergency recovery with validation
   */
  async emergencyRecovery(fromBlock: number = 0): Promise<{
    shieldsRecovered: number;
    transactionsRecovered: number;
    errors: string[];
  }> {
    try {
      // Validate fromBlock
      if (!Number.isInteger(fromBlock) || fromBlock < 0) {
        throw new LaserGunError('fromBlock must be a non-negative integer', ErrorCode.VALIDATION_ERROR);
      }

      const currentBlock = await this.configManager.getConfig().provider.getBlockNumber();
      if (fromBlock > currentBlock) {
        throw new LaserGunError(
          `fromBlock (${fromBlock}) cannot be greater than current block (${currentBlock})`,
          ErrorCode.VALIDATION_ERROR
        );
      }

      // Clear existing data
      await this.storage.deleteWalletData(
        this.configManager.getConfig().chainId, 
        this.configManager.getWallet()
      );
      
      // Re-initialize scanner with custom start block
      const scannerConfig = { 
        startBlock: fromBlock, 
        enableHDRecovery: true,
        batchSize: 100 // Smaller batches for emergency recovery
      };
      
      const emergencyScanner = new EventScanner(
        this.configManager.getConfig().contractAddress,
        this.configManager.getConfig().provider,
        this.storage,
        this.configManager.getConfig().chainId,
        scannerConfig
      );
      
      const keys = this.configManager.getKeys();
      if (!keys) {
        throw new LaserGunError('Keys not available for emergency recovery', ErrorCode.INVALID_CONFIG);
      }
      
      await emergencyScanner.initialize(this.configManager.getWallet(), keys);
      await emergencyScanner.recoverFromBlockchain();
      
      // Reload data
      const shields = await this.storage.loadShields(
        this.configManager.getConfig().chainId, 
        this.configManager.getWallet()
      );
      const transactions = await this.storage.loadTransactions(
        this.configManager.getConfig().chainId, 
        this.configManager.getWallet()
      );
      
      return {
        shieldsRecovered: shields.length,
        transactionsRecovered: transactions.length,
        errors: []
      };
      
    } catch (error) {
      throw new LaserGunError(
        `Failed emergency recovery: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.SCANNER_ERROR,
        error
      );
    }
  }

  /**
   * Validate data integrity
   */
  async validateDataIntegrity(): Promise<{
    isValid: boolean;
    issues: string[];
    suggestions: string[];
  }> {
    const issues: string[] = [];
    const suggestions: string[] = [];
    
    try {
      // Check if shields exist on blockchain
      const shields = await this.storage.loadShields(
        this.configManager.getConfig().chainId, 
        this.configManager.getWallet()
      );
      let invalidShields = 0;
      
      const contract = this.configManager.getContract();
      
      for (const shield of shields) {
        try {
          const shieldInfo = await contract.getShieldInfo(shield.commitment);
          if (!shieldInfo.exists) {
            invalidShields++;
          }
        } catch {
          invalidShields++;
        }
      }
      
      if (invalidShields > 0) {
        issues.push(`${invalidShields} shields not found on blockchain`);
        suggestions.push('Run syncWithBlockchain() to fix shield data');
      }
      
      // Check event counts consistency
      const eventCounts = await this.storage.loadEventCounts(
        this.configManager.getConfig().chainId, 
        this.configManager.getWallet()
      );
      if (!eventCounts) {
        issues.push('Event counts not found');
        suggestions.push('Run recoverFromBlockchain() to restore event counts');
      }
      
      // Check transaction consistency
      const transactions = await this.storage.loadTransactions(
        this.configManager.getConfig().chainId, 
        this.configManager.getWallet()
      );
      
      // Check for duplicate nonces within same type
      const nonceCounts = new Map<string, number>();
      for (const tx of transactions) {
        const key = `${tx.type}_${tx.nonce}`;
        nonceCounts.set(key, (nonceCounts.get(key) || 0) + 1);
      }
      
      let duplicateNonces = 0;
      for (const [, count] of nonceCounts) {
        if (count > 1) {
          duplicateNonces++;
        }
      }
      
      if (duplicateNonces > 0) {
        issues.push(`${duplicateNonces} duplicate transaction nonces found`);
        suggestions.push('Run emergencyRecovery() to rebuild transaction history');
      }
      
      return {
        isValid: issues.length === 0,
        issues,
        suggestions
      };
      
    } catch (error) {
      return {
        isValid: false,
        issues: [`Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
        suggestions: ['Try emergency recovery or re-initialization']
      };
    }
  }

  /**
   * Sync local storage with blockchain
   */
  async syncWithBlockchain(): Promise<{
    added: number;
    removed: number;
    updated: number;
  }> {
    let added = 0;
    let removed = 0;
    let updated = 0;
    
    try {
      const shields = await this.storage.loadShields(
        this.configManager.getConfig().chainId, 
        this.configManager.getWallet()
      );
      
      const contract = this.configManager.getContract();
      
      // Check each shield against blockchain
      for (const shield of shields) {
        try {
          const shieldInfo = await contract.getShieldInfo(shield.commitment);
          
          if (!shieldInfo.exists) {
            // Shield doesn't exist on blockchain, remove from storage
            await this.storage.deleteShield(
              this.configManager.getConfig().chainId, 
              this.configManager.getWallet(), 
              shield.commitment
            );
            removed++;
          } else if (shieldInfo.amount.toString() !== shield.amount) {
            // Amount mismatch, update storage
            const updatedShield = { ...shield, amount: shieldInfo.amount.toString() };
            await this.storage.saveShield(
              this.configManager.getConfig().chainId, 
              this.configManager.getWallet(), 
              updatedShield
            );
            updated++;
          }
        } catch {
          // If we can't check, assume invalid and remove
          await this.storage.deleteShield(
            this.configManager.getConfig().chainId, 
            this.configManager.getWallet(), 
            shield.commitment
          );
          removed++;
        }
      }
      
      // Run recovery to find any missing shields
      const recovery = await this.recoverFromBlockchain();
      added = recovery.shieldsRecovered - (shields.length - removed);
      
      return { added: Math.max(0, added), removed, updated };
      
    } catch (error) {
      throw new LaserGunError(
        `Failed to sync with blockchain: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.SCANNER_ERROR,
        error
      );
    }
  }

  /**
   * Get comprehensive recovery statistics
   */
  async getRecoveryStats(): Promise<{
    totalShields: number;
    activeShields: number;
    totalTransactions: number;
    transactionsByType: Record<string, number>;
    lastScannedBlock: number | null;
    eventCounts: EventCounts | null;
  }> {
    try {
      const [shields, transactions, eventCounts, lastScannedBlock] = await Promise.all([
        this.storage.loadShields(
          this.configManager.getConfig().chainId, 
          this.configManager.getWallet()
        ),
        this.storage.loadTransactions(
          this.configManager.getConfig().chainId, 
          this.configManager.getWallet()
        ),
        this.storage.loadEventCounts(
          this.configManager.getConfig().chainId, 
          this.configManager.getWallet()
        ),
        this.storage.getLastScannedBlock(
          this.configManager.getConfig().chainId, 
          this.configManager.getWallet()
        )
      ]);

      // Count active shields
      let activeShields = 0;
      const contract = this.configManager.getContract();
      
      for (const shield of shields) {
        try {
          const isActive = await contract.isCommitmentActive(shield.commitment);
          if (isActive) {
            activeShields++;
          }
        } catch {
          // Skip invalid shields
        }
      }

      // Count transactions by type
      const transactionsByType: Record<string, number> = {};
      for (const tx of transactions) {
        transactionsByType[tx.type] = (transactionsByType[tx.type] || 0) + 1;
      }

      return {
        totalShields: shields.length,
        activeShields,
        totalTransactions: transactions.length,
        transactionsByType,
        lastScannedBlock,
        eventCounts
      };

    } catch (error) {
      throw new LaserGunError(
        `Failed to get recovery stats: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }
}