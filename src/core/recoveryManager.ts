import type { IStorageAdapter, EventCounts } from '../types';
import { LaserGunError, ErrorCode } from '../types';
import { LaserGunConfigManager } from './config';
import { EventScanner } from './scanner';

/**
 * Recovery and synchronization manager
 * Handles blockchain recovery, data integrity validation, and synchronization
 * Uses single EventScanner instance - no duplicate creation
 */
export class RecoveryManager {
  private readonly configManager: LaserGunConfigManager;
  private readonly storage: IStorageAdapter;
  private readonly scanner: EventScanner;

  constructor(
    configManager: LaserGunConfigManager,
    storage: IStorageAdapter,
    scanner: EventScanner // Injected dependency - single instance
  ) {
    this.configManager = configManager;
    this.storage = storage;
    this.scanner = scanner; // Reuse existing scanner
  }

  /**
   * Recover all data from blockchain using existing scanner
   */
  async recoverFromBlockchain(): Promise<{
    shieldsRecovered: number;
    transactionsRecovered: number;
  }> {
    try {
      await this.configManager.checkNetworkConnection();
      
      // Use existing scanner's HD recovery mechanism
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
   * Clean up all data for specific chain and wallet
   */
  async cleanupData(): Promise<void> {
    try {
      await this.storage.deleteWalletData(
        this.configManager.getConfig().chainId, 
        this.configManager.getWallet()
      );
    } catch (error) {
      throw new LaserGunError(
        `Failed to cleanup data: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
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
        suggestions.push('Run cleanupData() + recoverFromBlockchain() to rebuild transaction history');
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
        suggestions: ['Try cleanupData() + recoverFromBlockchain() or re-initialization']
      };
    }
  }

  /**
   * Sync local storage with blockchain using existing scanner
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
          } else if (shieldInfo.amount !== shield.amount) {
            // Amount mismatch, update storage
            const updatedShield = { ...shield, amount: shieldInfo.amount };
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
      
      // Run recovery to find any missing shields using existing scanner
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