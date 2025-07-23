import { Contract, parseUnits, ZeroHash } from 'ethers';
import type { 
  IStorageAdapter, 
  Shield, 
  Transaction,
  ShieldResult,
  UnshieldResult,
  TransferResult,
  HexString,
  EventCounts 
} from '../types';
import { LaserGunError, ErrorCode, createEventCounts } from '../types';
import { CryptoService, HDSecretManager } from '../crypto';
import { LaserGunConfigManager } from '../core/config';
import { TokenManager } from './tokenOperations';

/**
 * Shield-related operations module
 * Handles shield creation, unshielding with remainder, and consolidation
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
   * DRY principle - eliminates code duplication
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
   * Shield (privatize) ERC20 tokens with HD derivation
   * ✅ CORRECT: Creates shield/N transaction with nonce = N
   */
  async shield(amount: string, tokenAddress: string): Promise<ShieldResult> {
    this.ensureInitialized();
    
    try {
      // Validate inputs
      if (!CryptoService.isValidAddress(tokenAddress)) {
        throw new LaserGunError('Invalid token address', ErrorCode.VALIDATION_ERROR);
      }
      
      const parsedAmount = parseUnits(amount, await this.tokenManager.getTokenDecimals(tokenAddress));
      if (parsedAmount <= 0n) {
        throw new LaserGunError('Amount must be positive', ErrorCode.INVALID_AMOUNT);
      }
      
      // Check balance and allowance
      await this.tokenManager.checkTokenBalance(tokenAddress, parsedAmount);
      await this.tokenManager.ensureAllowance(tokenAddress, parsedAmount);
      
      // Get current shield index and generate HD secret
      const currentCounts = this.getCurrentEventCounts();
      const shieldIndex = currentCounts.shield;
      const secret = this.hdManager!.deriveSecret('shield', shieldIndex);
      const commitment = CryptoService.generateCommitment(secret, this.configManager.getWallet());
      
      // Execute shield transaction
      const contract = this.configManager.getContract();
      const tx = await contract.shield(parsedAmount, tokenAddress, commitment);
      const receipt = await tx.wait();
      
      // Calculate net amount after fees
      const feePercent = await contract.shieldFeePercent();
      const feeDenominator = await contract.FEE_DENOMINATOR();
      const fee = parsedAmount * feePercent / feeDenominator;
      const netAmount = parsedAmount - fee;
      
      // Store shield with HD metadata
      const shield: Shield = {
        secret,
        commitment,
        token: tokenAddress,
        amount: netAmount.toString(),
        timestamp: Date.now(),
        derivationPath: `shield/${shieldIndex}`,
        hdIndex: shieldIndex,
        hdOperation: 'shield',
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber
      };
      
      const { chainId, wallet } = this.getStorageContext();
      await this.storage.saveShield(chainId, wallet, shield);
      
      // Update event counts
      const updatedCounts = createEventCounts({
        shield: currentCounts.shield + 1,
        remainder: currentCounts.remainder,
        received: currentCounts.received,
        consolidate: currentCounts.consolidate,
        lastUpdatedBlock: Math.max(receipt.blockNumber, currentCounts.lastUpdatedBlock)
      });
      
      await this.storage.saveEventCounts(chainId, wallet, updatedCounts);
      this.eventCounts = updatedCounts;
      
      // ✅ CORRECT HD: Save shield transaction with shield HD index as nonce
      const transaction: Transaction = {
        nonce: shieldIndex, // ✅ CORRECT: nonce = shield HD index (shield/0 → nonce=0)
        type: 'shield', // ✅ CORRECT: type = 'shield'
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: Date.now(),
        token: tokenAddress,
        amount: netAmount.toString(),
        commitment,
        fee: fee.toString(),
        derivationPath: `shield/${shieldIndex}`,
        hdIndex: shieldIndex,
        hdOperation: 'shield'
      };
      
      await this.storage.saveTransaction(chainId, wallet, transaction.nonce, transaction);
      
      return {
        success: true,
        txHash: receipt.hash,
        commitment,
        netAmount: netAmount.toString(),
        fee: fee.toString(),
        derivationPath: `shield/${shieldIndex}`,
        hdIndex: shieldIndex
      };
      
    } catch (error) {
      return {
        success: false,
        error: this.createError(error, 'Failed to shield tokens')
      };
    }
  }

  /**
   * Unshield (convert back to public) tokens with CORRECT HD handling
   * ✅ CORRECT: Creates separate transactions for remainder with proper HD derivation
   */
  async unshield(
    secret: HexString, 
    amount: string, 
    recipient: string
  ): Promise<UnshieldResult> {
    this.ensureInitialized();
    
    try {
      // Validate recipient
      if (!CryptoService.isValidAddress(recipient)) {
        throw new LaserGunError('Invalid recipient address', ErrorCode.VALIDATION_ERROR);
      }
      
      // Validate shield and get info
      const { commitment, shieldInfo, parsedAmount } = await this.validateAndGetShieldInfo(secret, amount);
      
      // Calculate remainder and generate remainder commitment if needed
      const remainderAmount = shieldInfo.amount - parsedAmount;
      let newCommitment = ZeroHash;
      let remainderDerivationPath: string | undefined;
      let remainderIndex: number | undefined;
      
      if (remainderAmount > 0n) {
        const currentCounts = this.getCurrentEventCounts();
        remainderIndex = currentCounts.remainder;
        const remainderSecret = this.hdManager!.deriveSecret('remainder', remainderIndex);
        newCommitment = CryptoService.generateCommitment(remainderSecret, this.configManager.getWallet());
        remainderDerivationPath = `remainder/${remainderIndex}`;
      }
      
      // Execute unshield transaction
      const contract = this.configManager.getContract();
      const tx = await contract.unshield(secret, parsedAmount, recipient, newCommitment);
      const receipt = await tx.wait();
      
      // Calculate net amount after fees
      const feePercent = await contract.unshieldFeePercent();
      const feeDenominator = await contract.FEE_DENOMINATOR();
      const fee = parsedAmount * feePercent / feeDenominator;
      const netAmount = parsedAmount - fee;
      
      // Get current counts for updating
      const currentCounts = this.getCurrentEventCounts();
      
      // Update event counts (increment remainder if remainder was created)
      const updatedCounts = createEventCounts({
        shield: currentCounts.shield,
        remainder: remainderAmount > 0n ? currentCounts.remainder + 1 : currentCounts.remainder,
        received: currentCounts.received,
        consolidate: currentCounts.consolidate,
        lastUpdatedBlock: Math.max(receipt.blockNumber, currentCounts.lastUpdatedBlock)
      });
      
      const { chainId, wallet } = this.getStorageContext();
      await this.storage.saveEventCounts(chainId, wallet, updatedCounts);
      this.eventCounts = updatedCounts;
      
      // ✅ CORRECT HD: Save remainder shield and transaction if created
      if (remainderAmount > 0n && remainderDerivationPath && remainderIndex !== undefined) {
        const remainderSecret = this.hdManager!.deriveSecret('remainder', remainderIndex);
        
        // Save remainder shield
        const remainderShield: Shield = {
          secret: remainderSecret,
          commitment: newCommitment,
          token: shieldInfo.token,
          amount: remainderAmount.toString(),
          timestamp: Date.now(),
          derivationPath: remainderDerivationPath,
          hdIndex: remainderIndex,
          hdOperation: 'remainder',
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber
        };
        
        await this.storage.saveShield(chainId, wallet, remainderShield);
        
        // ✅ CORRECT HD: Save remainder transaction with remainder HD index as nonce
        const remainderTransaction: Transaction = {
          nonce: remainderIndex, // ✅ CORRECT: nonce = remainder HD index (remainder/0 → nonce=0)
          type: 'remainder', // ✅ CORRECT: type = 'remainder' (NOT 'unshield'!)
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          timestamp: Date.now(),
          token: shieldInfo.token,
          amount: remainderAmount.toString(),
          commitment: newCommitment,
          derivationPath: remainderDerivationPath,
          hdIndex: remainderIndex,
          hdOperation: 'remainder'
        };
        
        await this.storage.saveTransaction(chainId, wallet, remainderTransaction.nonce, remainderTransaction);
      }
      
      // ✅ CORRECT HD: Main unshield operation gets its OWN HD derivation
      const unshieldIndex = currentCounts.shield + currentCounts.remainder + currentCounts.received + currentCounts.consolidate;
      
      const unshieldTransaction: Transaction = {
        nonce: unshieldIndex, // ✅ CORRECT: unshield gets its own sequential HD index
        type: 'unshield', // ✅ CORRECT: type = 'unshield'
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: Date.now(),
        token: shieldInfo.token,
        amount: netAmount.toString(),
        to: recipient,
        fee: fee.toString(),
        commitment: commitment // Reference to consumed shield
      };
      
      await this.storage.saveTransaction(chainId, wallet, unshieldTransaction.nonce, unshieldTransaction);
      
      return {
        success: true,
        txHash: receipt.hash,
        amount: netAmount.toString(),
        fee: fee.toString(),
        ...(remainderDerivationPath && { remainderDerivationPath })
      };
      
    } catch (error) {
      return {
        success: false,
        error: this.createError(error, 'Failed to unshield tokens')
      };
    }
  }

  /**
   * Consolidate multiple shields into one with HD derivation
   * ✅ CORRECT: Creates consolidate/N transaction with nonce = N
   */
  async consolidate(secrets: HexString[], tokenAddress: string): Promise<TransferResult> {
    this.ensureInitialized();
    
    try {
      // Validate inputs
      if (!secrets || secrets.length === 0) {
        throw new LaserGunError('No secrets provided', ErrorCode.VALIDATION_ERROR);
      }
      
      if (secrets.length > 10) {
        throw new LaserGunError('Too many shields to consolidate (max 10)', ErrorCode.VALIDATION_ERROR);
      }
      
      // Validate all secrets
      for (const secret of secrets) {
        if (!CryptoService.isValidHexString(secret)) {
          throw new LaserGunError('Invalid secret format', ErrorCode.VALIDATION_ERROR);
        }
      }
      
      // Check all shields exist and use same token
      let totalAmount = 0n;
      const contract = this.configManager.getContract();
      
      for (const secret of secrets) {
        const balance = await contract.getShieldBalance(secret, tokenAddress);
        if (balance === 0n) {
          throw new LaserGunError('Shield does not exist or already spent', ErrorCode.SHIELD_NOT_FOUND);
        }
        totalAmount += balance;
      }
      
      if (totalAmount === 0n) {
        throw new LaserGunError('Total amount must be positive', ErrorCode.INVALID_AMOUNT);
      }
      
      // Generate new commitment for consolidated shield using HD
      const currentCounts = this.getCurrentEventCounts();
      const consolidateIndex = currentCounts.consolidate;
      const newSecret = this.hdManager!.deriveSecret('consolidate', consolidateIndex);
      const newCommitment = CryptoService.generateCommitment(newSecret, this.configManager.getWallet());
      
      // Execute consolidate transaction
      const tx = await contract.consolidate(secrets, newCommitment);
      const receipt = await tx.wait();
      
      // Store consolidated shield with HD metadata
      const shield: Shield = {
        secret: newSecret,
        commitment: newCommitment,
        token: tokenAddress,
        amount: totalAmount.toString(),
        timestamp: Date.now(),
        derivationPath: `consolidate/${consolidateIndex}`,
        hdIndex: consolidateIndex,
        hdOperation: 'consolidate',
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber
      };
      
      const { chainId, wallet } = this.getStorageContext();
      await this.storage.saveShield(chainId, wallet, shield);
      
      // Update event counts
      const updatedCounts = createEventCounts({
        shield: currentCounts.shield,
        remainder: currentCounts.remainder,
        received: currentCounts.received,
        consolidate: currentCounts.consolidate + 1,
        lastUpdatedBlock: Math.max(receipt.blockNumber, currentCounts.lastUpdatedBlock)
      });
      
      await this.storage.saveEventCounts(chainId, wallet, updatedCounts);
      this.eventCounts = updatedCounts;
      
      // ✅ CORRECT HD: Save consolidate transaction with consolidate HD index as nonce
      const transaction: Transaction = {
        nonce: consolidateIndex, // ✅ CORRECT: nonce = consolidate HD index (consolidate/0 → nonce=0)
        type: 'consolidate', // ✅ CORRECT: type = 'consolidate' (NOT 'transfer'!)
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: Date.now(),
        token: tokenAddress,
        amount: totalAmount.toString(),
        commitment: newCommitment,
        derivationPath: `consolidate/${consolidateIndex}`,
        hdIndex: consolidateIndex,
        hdOperation: 'consolidate'
      };
      
      await this.storage.saveTransaction(chainId, wallet, transaction.nonce, transaction);
      
      return {
        success: true,
        txHash: receipt.hash,
        recipientCommitment: newCommitment,
        amount: totalAmount.toString(),
        derivationPath: `consolidate/${consolidateIndex}`
      };
      
    } catch (error) {
      return {
        success: false,
        error: this.createError(error, 'Failed to consolidate shields')
      };
    }
  }

  // Helper methods
  private ensureInitialized(): void {
    if (!this.hdManager || !this.eventCounts) {
      throw new LaserGunError('ShieldOperations not properly initialized', ErrorCode.INVALID_CONFIG);
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