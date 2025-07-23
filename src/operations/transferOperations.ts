import type { 
  IStorageAdapter, 
  TransferResult,
  HexString,
  EventCounts 
} from '../types';
import { HDSecretManager } from '../crypto';
import { LaserGunConfigManager } from '../core/config';
import { TokenManager } from './tokenOperations';
import { 
  ValidationUtils, 
  HDHelpers, 
  ErrorHelpers, 
  StorageHelpers,
  ContractHelpers 
} from '../utils';

/**
 * Transfer-related operations module (REFACTORED)
 * Handles private transfers between users with utilities
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

  setHDManager(hdManager: HDSecretManager): void {
    this.hdManager = hdManager;
  }

  setEventCounts(eventCounts: EventCounts): void {
    this.eventCounts = eventCounts;
  }

  /**
   * Transfer tokens privately to another user
   * Creates transfer transaction with its own HD index
   */
  async transfer(
    secret: HexString,
    amount: string,
    recipientCommitment: HexString,
    encryptedSecret: string
  ): Promise<TransferResult> {
    ValidationUtils.validateInitialization(this.hdManager, this.eventCounts, 'TransferOperations');
    
    try {
      // Validate all transfer parameters
      ValidationUtils.validateRecipientParams(recipientCommitment, encryptedSecret);
      
      // Validate shield and get info
      const { commitment, shieldInfo, parsedAmount } = await ValidationUtils.validateAndGetShieldInfo(
        secret, amount, this.configManager, this.tokenManager
      );
      
      // Execute transfer transaction
      const contract = this.configManager.getContract();
      const tx = await contract.transfer(secret, parsedAmount, recipientCommitment, encryptedSecret);
      const receipt = await ContractHelpers.waitForTransaction(tx);
      
      // Save transfer transaction with sequential HD index
      await this.saveTransferTransaction(
        receipt, shieldInfo.token, parsedAmount.toString(), 
        recipientCommitment, commitment
      );
      
      return {
        success: true,
        txHash: receipt.hash,
        recipientCommitment,
        amount: parsedAmount.toString()
      };
      
    } catch (error) {
      return {
        success: false,
        error: ErrorHelpers.createError(error, 'Failed to transfer tokens')
      };
    }
  }

  /**
   * Save transfer transaction (non-HD operation with sequential index)
   */
  private async saveTransferTransaction(
    receipt: any,
    token: string,
    amount: string,
    recipientCommitment: HexString,
    sourceCommitment: HexString
  ): Promise<void> {
    const { chainId, wallet } = this.getStorageContext();
    
    // Transfer gets sequential index across all operations
    const transferIndex = HDHelpers.getSequentialIndex(this.eventCounts!);
    
    const transaction = HDHelpers.createHDTransaction(
      transferIndex,
      'transfer',
      receipt.hash,
      receipt.blockNumber,
      token,
      amount,
      recipientCommitment,
      undefined, // No HD operation for transfers
      undefined, // No HD index for transfers
      { 
        from: sourceCommitment // Source commitment (consumed shield)
      }
    );
    
    await StorageHelpers.saveTransactionSafely(this.storage, chainId, wallet, transaction);
  }

  private getStorageContext(): { chainId: number; wallet: string } {
    return {
      chainId: this.configManager.getConfig().chainId,
      wallet: this.configManager.getWallet()
    };
  }
}