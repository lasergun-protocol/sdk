import { ZeroHash } from 'ethers';
import {
  type IStorageAdapter,
  type ShieldResult,
  type UnshieldResult,
  type TransferResult,
  type HexString,
  type EventCounts,
  ErrorCode,
  LaserGunError
} from '../types';
import { CryptoService, HDSecretManager } from '../crypto';
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
 * Shield-related operations module (HD FULL)
 * Uses HD nonce for ALL operations including unshield
 */
export class ShieldOperations {
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
   * Shield (privatize) ERC20 tokens with HD derivation
   */
  async shield(amount: bigint, tokenAddress: string): Promise<ShieldResult> {
    ValidationUtils.validateInitialization(this.hdManager, this.eventCounts, 'ShieldOperations');

    try {
      // Validate inputs
      ValidationUtils.validateAddress(tokenAddress, 'token address');

      const parsedAmount = BigInt(amount);
      if (parsedAmount <= 0n) {
        throw ErrorHelpers.validationError('amount', amount, 'positive number');
      }

      // Check balance and allowance
      await this.tokenManager.checkTokenBalance(tokenAddress, parsedAmount);
      await this.tokenManager.ensureAllowance(tokenAddress, parsedAmount);

      // Generate HD secret and commitment
      const currentCounts = this.eventCounts!;
      const shieldIndex = currentCounts.shield;
      const { secret, commitment } = HDHelpers.generateHDSecretAndCommitment(
        this.hdManager!, 'shield', shieldIndex, this.configManager.getWallet()
      );

      // Execute shield transaction
      const contract = this.configManager.getContract();
      const tx = await contract.shield(parsedAmount, tokenAddress, commitment);
      const receipt = await ContractHelpers.waitForTransaction(tx);

      // Calculate fees
      const { shieldFeePercent, feeDenominator } = await ContractHelpers.getFeeInfo(contract);
      const { netAmount, fee } = ContractHelpers.calculateNetAmount(
        parsedAmount, shieldFeePercent, feeDenominator
      );

      // Save shield and update counts
      await this.saveShieldAndTransaction(
        secret, commitment, tokenAddress, netAmount,
        'shield', shieldIndex, receipt, fee
      );

      return {
        success: true,
        txHash: receipt.hash,
        commitment,
        netAmount: netAmount,
        fee: fee,
        derivationPath: `shield/${shieldIndex}`,
        hdIndex: shieldIndex
      };

    } catch (error) {
      return {
        success: false,
        error: ErrorHelpers.createError(error, 'Failed to shield tokens')
      };
    }
  }

  /**
   * Unshield (convert back to public) tokens with HD remainder handling
   * ИЗМЕНЕНО: Теперь использует HD nonce для unshield операции
   */
  async unshield(
    secret: HexString,
    amount: bigint,
    recipient: string
  ): Promise<UnshieldResult> {
    ValidationUtils.validateInitialization(this.hdManager, this.eventCounts, 'ShieldOperations');

    try {
      ValidationUtils.validateAddress(recipient, 'recipient address');
      
      const { commitment, shieldInfo } = await ShieldOperations.getShieldInfo(
        secret, this.configManager
      );

      // Validate shield and get info
      await ValidationUtils.validateShield(
        shieldInfo, secret, amount
      ); 

      // Handle remainder if needed
      const remainderAmount = shieldInfo.amount - amount;
      let newCommitment = ZeroHash;
      let remainderData: { index: number; path: string } | undefined;

      if (remainderAmount > 0n) {
        const currentCounts = this.eventCounts!;
        const remainderIndex = currentCounts.remainder;
        const { commitment: remCommitment } = HDHelpers.generateHDSecretAndCommitment(
          this.hdManager!, 'remainder', remainderIndex, this.configManager.getWallet()
        );
        newCommitment = remCommitment;
        remainderData = { index: remainderIndex, path: `remainder/${remainderIndex}` };
      }

      // Execute unshield transaction
      const contract = this.configManager.getContract();
      const tx = await contract.unshield(secret, amount, recipient, newCommitment);
      const receipt = await ContractHelpers.waitForTransaction(tx);

      // Calculate fees
      const { unshieldFeePercent, feeDenominator } = await ContractHelpers.getFeeInfo(contract);
      const { netAmount, fee } = ContractHelpers.calculateNetAmount(
        amount, unshieldFeePercent, feeDenominator
      );

      // Save remainder shield if created
      if (remainderAmount > 0n && remainderData) {
        await this.saveRemainderShield(
          remainderData.index, newCommitment as HexString, shieldInfo.token,
          remainderAmount, receipt
        );
      }

      // ИЗМЕНЕНО: Save unshield transaction with HD nonce
      await this.saveUnshieldTransaction(receipt, shieldInfo.token, netAmount, fee, recipient, commitment);

      return {
        success: true,
        txHash: receipt.hash,
        amount: netAmount,
        fee: fee,
        ...(remainderData && { remainderDerivationPath: remainderData.path })
      };

    } catch (error) {
      return {
        success: false,
        error: ErrorHelpers.createError(error, 'Failed to unshield tokens')
      };
    }
  }

  /**
   * Consolidate multiple shields into one with HD derivation
   */
  async consolidate(secrets: HexString[], tokenAddress: string): Promise<TransferResult> {
    ValidationUtils.validateInitialization(this.hdManager, this.eventCounts, 'ShieldOperations');

    try {
      ValidationUtils.validateSecretsArray(secrets);
      ValidationUtils.validateAddress(tokenAddress, 'token address');

      // Check all shields and calculate total
      const totalAmount = await this.validateAndCalculateTotal(secrets, tokenAddress);

      // Generate new commitment for consolidated shield
      const currentCounts = this.eventCounts!;
      const consolidateIndex = currentCounts.consolidate;
      const { secret: newSecret, commitment: newCommitment } = HDHelpers.generateHDSecretAndCommitment(
        this.hdManager!, 'consolidate', consolidateIndex, this.configManager.getWallet()
      );

      // Execute consolidate transaction
      const contract = this.configManager.getContract();
      const tx = await contract.consolidate(secrets, newCommitment);
      const receipt = await ContractHelpers.waitForTransaction(tx);

      // Save consolidated shield and transaction
      await this.saveShieldAndTransaction(
        newSecret, newCommitment, tokenAddress, totalAmount,
        'consolidate', consolidateIndex, receipt
      );

      return {
        success: true,
        txHash: receipt.hash,
        recipientCommitment: newCommitment,
        amount: totalAmount,
        derivationPath: `consolidate/${consolidateIndex}`
      };

    } catch (error) {
      return {
        success: false,
        error: ErrorHelpers.createError(error, 'Failed to consolidate shields')
      };
    }
  }

  /**
   * Save shield and transaction with HD metadata
   */
  private async saveShieldAndTransaction(
    secret: HexString,
    commitment: HexString,
    token: string,
    amount: bigint,
    operation: 'shield' | 'consolidate',
    index: number,
    receipt: any,
    fee?: bigint
  ): Promise<void> {
    const { chainId, wallet } = this.getStorageContext();

    // Save shield
    const shield = HDHelpers.createHDShield(
      secret, commitment, token, amount, operation, index, receipt.hash, receipt.blockNumber
    );
    await StorageHelpers.saveShield(this.storage, chainId, wallet, shield);

    // Update event counts
    const updatedCounts = HDHelpers.updateEventCounts(
      this.eventCounts!, operation, 1, receipt.blockNumber
    );
    await StorageHelpers.saveEventCounts(this.storage, chainId, wallet, updatedCounts);
    this.eventCounts = updatedCounts;

    // Save transaction
    const transaction = HDHelpers.createHDTransaction(
      index, operation, receipt.hash, receipt.blockNumber, token, amount, fee!,
      commitment, operation, index, { ...(fee && { fee }) }
    );
    await StorageHelpers.saveTransaction(this.storage, chainId, wallet, transaction);
  }

  /**
   * Save remainder shield after unshield
   */
  private async saveRemainderShield(
    remainderIndex: number,
    commitment: HexString,
    token: string,
    amount: bigint,
    receipt: any
  ): Promise<void> {
    const { chainId, wallet } = this.getStorageContext();

    const remainderSecret = this.hdManager!.deriveSecret('remainder', remainderIndex);
    const remainderShield = HDHelpers.createHDShield(
      remainderSecret, commitment, token, amount, 'remainder', remainderIndex, receipt.hash, receipt.blockNumber
    );

    await StorageHelpers.saveShield(this.storage, chainId, wallet, remainderShield);

    // Update event counts
    const updatedCounts = HDHelpers.updateEventCounts(
      this.eventCounts!, 'remainder', 1, receipt.blockNumber
    );
    await StorageHelpers.saveEventCounts(this.storage, chainId, wallet, updatedCounts);
    this.eventCounts = updatedCounts;

    // Save remainder transaction
    const transaction = HDHelpers.createHDTransaction(
      remainderIndex, 'remainder', receipt.hash, receipt.blockNumber, token, amount, 0n,
      commitment, 'remainder', remainderIndex
    );
    await StorageHelpers.saveTransaction(this.storage, chainId, wallet, transaction);
  }

  /**
   * ИЗМЕНЕНО: Save unshield transaction with HD nonce
   */
  private async saveUnshieldTransaction(
    receipt: any,
    token: string,
    amount: bigint,
    fee: bigint,
    recipient: string,
    sourceCommitment: HexString
  ): Promise<void> {
    const { chainId, wallet } = this.getStorageContext();

    // ИЗМЕНЕНО: Используем HD nonce для unshield
    const unshieldIndex = this.eventCounts!.unshield;
    const transaction = HDHelpers.createHDTransaction(
      unshieldIndex, 'unshield', receipt.hash, receipt.blockNumber, token, amount, fee,
      sourceCommitment, 'unshield', unshieldIndex, { to: recipient, fee }
    );

    await StorageHelpers.saveTransaction(this.storage, chainId, wallet, transaction);

    // ДОБАВЛЕНО: Обновляем и сохраняем unshield счетчик
    const updatedCounts = HDHelpers.updateEventCounts(
      this.eventCounts!, 'unshield', 1, receipt.blockNumber
    );
    await StorageHelpers.saveEventCounts(this.storage, chainId, wallet, updatedCounts);
    this.eventCounts = updatedCounts;
  }

  /**
   * Validate shields for consolidation and calculate total
   */
  private async validateAndCalculateTotal(secrets: HexString[], tokenAddress: string): Promise<bigint> {
    const contract = this.configManager.getContract();
    let totalAmount = 0n;

    for (const secret of secrets) {
      const balance = await ContractHelpers.getShieldBalance(contract, secret, tokenAddress);
      if (balance === 0n) {
        throw ErrorHelpers.shieldNotFoundError();
      }
      totalAmount += balance;
    }

    if (totalAmount === 0n) {
      throw ErrorHelpers.validationError('total amount', 0n, 'positive');
    }

    return totalAmount;
  }

  private getStorageContext(): { chainId: number; wallet: string } {
    return {
      chainId: this.configManager.getConfig().chainId,
      wallet: this.configManager.getWallet()
    };
  }

  /**
   * Validate and get shield info with parsed amount
   * Common pattern used in shield and transfer operations
   */
  static async getShieldInfo(
    secret: HexString,
    configManager: LaserGunConfigManager
  ): Promise<{
    commitment: HexString;
    shieldInfo: any;
  }> {

    const wallet = configManager.getWallet();
    const contract = configManager.getContract();

    const commitment = CryptoService.generateCommitment(secret, wallet);
    const shieldInfo = await contract.getShieldInfo(commitment);

    if (!shieldInfo.exists || shieldInfo.spent) {
      throw new LaserGunError('Shield does not exist or already spent', ErrorCode.SHIELD_NOT_FOUND);
    }

    return { commitment, shieldInfo };
  }
}