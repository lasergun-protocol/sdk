import type { HexString } from '../types';
import { LaserGunError, ErrorCode } from '../types';
import { CryptoService } from '../crypto';

/**
 * Common validation utilities for LaserGun operations
 * Eliminates code duplication across shield and transfer operations
 */
export class ValidationUtils {
  
  /**
   * Validate basic shield parameters
   */
  static validateShieldParams(
    secret: HexString, 
    amount: bigint, 
    tokenAddress?: string
  ): void {
    if (!CryptoService.isValidHexString(secret)) {
      throw new LaserGunError('Invalid secret format', ErrorCode.VALIDATION_ERROR);
    }
    
    if (!amount || amount <= 0n ) {
      throw new LaserGunError('Amount must be positive', ErrorCode.INVALID_AMOUNT);
    }
    
    if (tokenAddress && !CryptoService.isValidAddress(tokenAddress)) {
      throw new LaserGunError('Invalid token address', ErrorCode.VALIDATION_ERROR);
    }
  }

  /**
   * Validate recipient parameters for transfers
   */
  static validateRecipientParams(
    recipientCommitment: HexString,
    encryptedSecret: string
  ): void {
    if (!CryptoService.isValidHexString(recipientCommitment)) {
      throw new LaserGunError('Invalid recipient commitment', ErrorCode.VALIDATION_ERROR);
    }
    
    if (!encryptedSecret || encryptedSecret === '0x') {
      throw new LaserGunError('Encrypted secret is required', ErrorCode.VALIDATION_ERROR);
    }
  }

  /**
   * Validate and get shield info with parsed amount
   * Common pattern used in shield and transfer operations
   */
  static async validateShield( 
    shieldInfo: any,
    secret: HexString,
    amount: bigint 
  ): Promise<void> {
    ValidationUtils.validateShieldParams(secret, amount);
     
    
    if (!shieldInfo.exists || shieldInfo.spent) {
      throw new LaserGunError('Shield does not exist or already spent', ErrorCode.SHIELD_NOT_FOUND);
    } 
    
    if (amount <= 0n) {
      throw new LaserGunError('Amount must be positive', ErrorCode.INVALID_AMOUNT);
    }
    
    if (shieldInfo.amount < amount) {
      throw new LaserGunError('Insufficient shield balance', ErrorCode.INSUFFICIENT_BALANCE);
    } 
  }

  /**
   * Validate secrets array for consolidation
   */
  static validateSecretsArray(secrets: HexString[]): void {
    if (!secrets || secrets.length === 0) {
      throw new LaserGunError('No secrets provided', ErrorCode.VALIDATION_ERROR);
    }
    
    if (secrets.length > 10) {
      throw new LaserGunError('Too many shields to consolidate (max 10)', ErrorCode.VALIDATION_ERROR);
    }
    
    for (const secret of secrets) {
      if (!CryptoService.isValidHexString(secret)) {
        throw new LaserGunError('Invalid secret format', ErrorCode.VALIDATION_ERROR);
      }
    }
  }

  /**
   * Validate address (recipient, token, etc.)
   */
  static validateAddress(address: string, fieldName: string = 'address'): void {
    if (!CryptoService.isValidAddress(address)) {
      throw new LaserGunError(`Invalid ${fieldName}`, ErrorCode.VALIDATION_ERROR);
    }
  }

  /**
   * Validate initialization state
   */
  static validateInitialization(
    hdManager: any, 
    eventCounts: any, 
    moduleName: string = 'Module'
  ): void {
    if (!hdManager || !eventCounts) {
      throw new LaserGunError(
        `${moduleName} not properly initialized`, 
        ErrorCode.INVALID_CONFIG
      );
    }
  }

  /**
   * Validate HD derivation parameters
   */
  static validateHDParams(operation: string, index: number): void {
    const validOperations = ['shield', 'remainder', 'received', 'consolidate'];
    
    if (!validOperations.includes(operation)) {
      throw new LaserGunError(
        `Invalid HD operation: ${operation}`, 
        ErrorCode.HD_DERIVATION_ERROR
      );
    }
    
    if (!Number.isInteger(index) || index < 0) {
      throw new LaserGunError(
        `Invalid HD index: ${index}`, 
        ErrorCode.HD_DERIVATION_ERROR
      );
    }
  }

  /**
   * Validate block number parameter
   */
  static validateBlockNumber(blockNumber: number, fieldName: string = 'block number'): void {
    if (!Number.isInteger(blockNumber) || blockNumber < 0) {
      throw new LaserGunError(
        `Invalid ${fieldName}: must be non-negative integer`, 
        ErrorCode.VALIDATION_ERROR
      );
    }
  }

  /**
   * Validate commitment format
   */
  static validateCommitment(commitment: string, fieldName: string = 'commitment'): void {
    if (!commitment || commitment === '0x' || !CryptoService.isValidHexString(commitment)) {
      throw new LaserGunError(`Invalid ${fieldName}`, ErrorCode.VALIDATION_ERROR);
    }
  }
}