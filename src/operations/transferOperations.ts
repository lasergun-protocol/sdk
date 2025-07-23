import { parseUnits } from 'ethers';
import type { 
  IStorageAdapter, 
  Transaction,
  TransferResult,
  HexString,
  EventCounts 
} from '../types';
import { LaserGunError, ErrorCode } from '../types';
import { CryptoService, HDSecretManager } from '../crypto';
import { LaserGunConfigManager } from '../core/config';
import { TokenManager } from './tokenOperations';

/**
 * Transfer-related operations module
 * Handles private transfers between users
 */
export class TransferOperations {
  private readonly configManager: LaserGunConfigManager;
  private readonly storage: IStorageAdapter;
  private readonly tokenManager: TokenManager;
  private hdManager: HDSecretManager | null = null;
  private eventCounts: EventCounts | null = null;

  constructor(
    configManager: LaserGunConfigManager, 
    storage: IStorageAdapter,
    tokenManager: TokenManager
  ) {
    this.configManager = configManager;
    this.storage = storage;
    this.tokenManager = tokenManager;
  }

  /**
   * Set HD manager (after initialization)
   */
  setHDManager(hdManager: HDSecretManager): void {
    this.hdManager = hdManager;
  }

  /**
   * Set event counts (from storage or initialization)
   */
  setEventCounts(eventCounts: EventCounts): void {
    this.eventCounts = eventCounts;
  }

  /**
   * Validate shield info and return common data
   * DRY principle - shared with shield operations
   */
  private async validateAndGetShieldInfo(secret: HexString, amount: string): Promise<{
    commitment: HexString;
    shieldInfo: any;
    tokenDecimals: number;
    parsedAmount: bigint;
  }> {
    if (!CryptoService.isValidHexString(secret)) {
      throw new LaserGunError('Invalid secret format', ErrorCode.VALIDATION_ERROR);
    }
    
    const wallet = this.configManager.getWallet();
    const contract = this.configManager.getContract();
    
    const commitment = CryptoService.generateCommitment(secret, wallet);
    const shieldInfo = await contract.getShieldInfo(commitment);
    
    if (!shieldInfo.exists || shieldInfo.spent) {
      throw new LaserGunError('Shield does not exist or already spent', ErrorCode.SHIELD_NOT_FOUND);
    }
    
    const tokenDecimals = await this.tokenManager.getTokenDecimals(shieldInfo.token);
    const parsedAmount = parseUnits(amount, tokenDecimals);
    
    if (parsedAmount <= 0n) {
      throw new LaserGunError('Amount must be positive', ErrorCode.INVALID_AMOUNT);
    }
    
    if (shieldInfo.amount < parsedAmount) {
      throw new LaserGunError('Insufficient shield balance', ErrorCode.INSUFFICIENT_BALANCE);
    }
    
    return { commitment, shieldInfo, tokenDecimals, parsedAmount };
  }

  /**
   * Transfer tokens privately to another user
   * ✅ CORRECT: Creates transfer transaction with its own HD index
   */
  async transfer(
    secret: HexString,
    amount: string,
    recipientCommitment: HexString,
    encryptedSecret: string
  ): Promise<TransferResult> {
    this.ensureInitialized();
    
    try {
      // Validate recipient commitment
      if (!CryptoService.isValidHexString(recipientCommitment)) {
        throw new LaserGunError('Invalid recipient commitment', ErrorCode.VALIDATION_ERROR);
      }
      
      if (!encryptedSecret || encryptedSecret === '0x') {
        throw new LaserGunError('Encrypted secret is required', ErrorCode.VALIDATION_ERROR);
      }
      
      // Validate shield and get info
      const { commitment, shieldInfo, parsedAmount } = await this.validateAndGetShieldInfo(secret, amount);
      
      // Execute transfer transaction
      const contract = this.configManager.getContract();
      const tx = await contract.transfer(secret, parsedAmount, recipientCommitment, encryptedSecret);
      const receipt = await tx.wait();
      
      // ✅ CORRECT HD: Transfer operation gets its OWN HD derivation
      // Use current total operations as HD index for transfer operations
      const currentCounts = this.getCurrentEventCounts();
      const transferIndex = currentCounts.shield + currentCounts.remainder + currentCounts.received + currentCounts.consolidate;
      
      const transferTransaction: Transaction = {
        nonce: transferIndex, // ✅ CORRECT: transfer gets its own sequential HD index  
        type: 'transfer', // ✅ CORRECT: type = 'transfer'
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: Date.now(),
        token: shieldInfo.token,
        amount: parsedAmount.toString(),
        commitment: recipientCommitment, // Target commitment
        from: commitment // Source commitment (consumed shield) - NOTE: Need to add to types
      };
      
      const { chainId, wallet } = this.getStorageContext();
      await this.storage.saveTransaction(chainId, wallet, transferTransaction.nonce, transferTransaction);
      
      return {
        success: true,
        txHash: receipt.hash,
        recipientCommitment,
        amount: parsedAmount.toString()
      };
      
    } catch (error) {
      return {
        success: false,
        error: this.createError(error, 'Failed to transfer tokens')
      };
    }
  }

  // Helper methods
  private ensureInitialized(): void {
    if (!this.hdManager || !this.eventCounts) {
      throw new LaserGunError('TransferOperations not properly initialized', ErrorCode.INVALID_CONFIG);
    }
  }

  private getCurrentEventCounts(): EventCounts {
    if (!this.eventCounts) {
      throw new LaserGunError('Event counts not initialized', ErrorCode.INVALID_CONFIG);
    }
    return this.eventCounts;
  }

  private getStorageContext(): { chainId: number; wallet: string } {
    return {
      chainId: this.configManager.getConfig().chainId,
      wallet: this.configManager.getWallet()
    };
  }

  private createError(error: unknown, message: string): LaserGunError {
    if (error instanceof LaserGunError) {
      return error;
    }
    
    return new LaserGunError(
      `${message}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      ErrorCode.CONTRACT_ERROR,
      error
    );
  }
}