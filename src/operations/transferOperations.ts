import type {
  IStorageAdapter,
  TransferResult,
  HexString,
  EventCounts
} from '../types';
import { HDSecretManager } from '../crypto';
import { LaserGunConfigManager } from '../core/config'; 
import {
  ValidationUtils,
  HDHelpers,
  ErrorHelpers,
  StorageHelpers,
  ContractHelpers
} from '../utils';
import { ShieldOperations } from './shieldOperations';

/**
 * Transfer-related operations module (REFACTORED)
 * Handles private transfers between users with utilities
 */
export class TransferOperations {
  private readonly configManager: LaserGunConfigManager;
  private readonly storage: IStorageAdapter; 
  private hdManager: HDSecretManager | null = null;
  private eventCounts: EventCounts | null = null;

  constructor(
    configManager: LaserGunConfigManager,
    storage: IStorageAdapter 
  ) {
    this.configManager = configManager;
    this.storage = storage; 
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
    amount: bigint,
    recipientCommitment: HexString,
    encryptedSecret: string
  ): Promise<TransferResult> {
    ValidationUtils.validateInitialization(this.hdManager, this.eventCounts, 'TransferOperations');

    try {
      // Validate all transfer parameters
      ValidationUtils.validateRecipientParams(recipientCommitment, encryptedSecret);

      const { commitment, shieldInfo } = await ShieldOperations.getShieldInfo(
        secret, this.configManager
      );

      // Validate shield and get info
      await ValidationUtils.validateShield(
        shieldInfo, secret, amount
      ); 


      // Execute transfer transaction
      const contract = this.configManager.getContract();
      const { transferFeePercent, feeDenominator } = await ContractHelpers.getFeeInfo(contract);
      const tx = await contract.transfer(secret, amount, recipientCommitment, encryptedSecret);
      const receipt = await ContractHelpers.waitForTransaction(tx);


      const { netAmount, fee } = ContractHelpers.calculateNetAmount(
        amount, transferFeePercent, feeDenominator
      );


      // Save transfer transaction with sequential HD index
      await this.saveTransferTransaction(
        receipt, shieldInfo.token, netAmount, fee,
        recipientCommitment, commitment
      );

      return {
        success: true,
        txHash: receipt.hash,
        recipientCommitment,
        amount
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
    amount: bigint,
    fee: bigint,
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
      fee,
      recipientCommitment,
      undefined, // No HD operation for transfers
      undefined, // No HD index for transfers
      {
        from: sourceCommitment // Source commitment (consumed shield)
      }
    );

    await StorageHelpers.saveTransaction(this.storage, chainId, wallet, transaction);
  }

  private getStorageContext(): { chainId: number; wallet: string } {
    return {
      chainId: this.configManager.getConfig().chainId,
      wallet: this.configManager.getWallet()
    };
  }
}