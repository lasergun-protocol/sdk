import { keccak256, solidityPacked } from 'ethers';
import type { HexString } from '../types';
import { LaserGunError, ErrorCode } from '../types';
import { CryptoService } from './CryptoService';

/**
 * Supported HD derivation operations
 */
export enum HDOperation {
  SHIELD = 'shield',
  REMAINDER = 'remainder', 
  RECEIVED = 'received',
  CONSOLIDATE = 'consolidate'
}

/**
 * Maximum allowed index for HD derivation (safety limit)
 */
export const MAX_HD_INDEX = 10000;

/**
 * HD Secret Manager for hierarchical secret derivation
 * Uses derivation paths like HD wallets: operation/index
 */
export class HDSecretManager {
  private readonly masterSeed: HexString;
  private readonly walletAddress: string;
  private readonly chainId: number;
  
  constructor(privateKey: HexString, walletAddress: string, chainId: number) {
    if (!CryptoService.isValidHexString(privateKey)) {
      throw new LaserGunError('Invalid private key format', ErrorCode.CRYPTO_ERROR);
    }
    if (!CryptoService.isValidAddress(walletAddress)) {
      throw new LaserGunError('Invalid wallet address', ErrorCode.CRYPTO_ERROR);
    }
    if (chainId <= 0) {
      throw new LaserGunError('Invalid chain ID', ErrorCode.CRYPTO_ERROR);
    }
    
    this.walletAddress = walletAddress.toLowerCase();
    this.chainId = chainId;
    
    // Generate deterministic master seed for this wallet/chain
    this.masterSeed = keccak256(
      solidityPacked(
        ['bytes32', 'address', 'uint256', 'string'],
        [privateKey, walletAddress, chainId, 'LASERGUN_HD_MASTER_V1']
      )
    ) as HexString;
  }
  
  /**
   * Generate secret by hierarchical derivation path
   */
  deriveSecret(operation: HDOperation | string, index: number): HexString {
    this.validateDerivationParams(operation, index);
    
    const path = `${operation}/${index}`;
    
    try {
      return keccak256(
        solidityPacked(
          ['bytes32', 'string'],
          [this.masterSeed, path]
        )
      ) as HexString;
    } catch (error) {
      throw new LaserGunError(
        `Failed to derive secret for path ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.CRYPTO_ERROR,
        error
      );
    }
  }
  
  /**
   * Generate multiple secrets for operation type with memory efficiency
   */
  *deriveMultipleSecrets(operation: HDOperation | string, count: number): Generator<{secret: HexString, index: number, path: string}> {
    this.validateDerivationParams(operation, 0);
    
    if (count <= 0 || count > MAX_HD_INDEX) {
      throw new LaserGunError(
        `Invalid count ${count}. Must be between 1 and ${MAX_HD_INDEX}`,
        ErrorCode.CRYPTO_ERROR
      );
    }
    
    for (let i = 0; i < count; i++) {
      const secret = this.deriveSecret(operation, i);
      yield {
        secret,
        index: i,
        path: `${operation}/${i}`
      };
    }
  }
  
  /**
   * Recover secret by full derivation path
   */
  recoverSecretByPath(path: string): HexString {
    if (!path || typeof path !== 'string') {
      throw new LaserGunError('Path must be a non-empty string', ErrorCode.CRYPTO_ERROR);
    }
    
    const parts = path.split('/');
    if (parts.length !== 2) {
      throw new LaserGunError(
        `Invalid path format ${path}. Expected "operation/index"`,
        ErrorCode.CRYPTO_ERROR
      );
    }
    
    const [operation, indexStr] = parts;
    const index = parseInt(indexStr, 10);
    
    if (isNaN(index)) {
      throw new LaserGunError(
        `Invalid index in path ${path}. Index must be a number`,
        ErrorCode.CRYPTO_ERROR
      );
    }
    
    return this.deriveSecret(operation, index);
  }
  
  /**
   * Get master seed (for debugging/verification only)
   */
  getMasterSeed(): HexString {
    return this.masterSeed;
  }
  
  /**
   * Get wallet context
   */
  getContext(): {walletAddress: string, chainId: number} {
    return {
      walletAddress: this.walletAddress,
      chainId: this.chainId
    };
  }

  /**
   * Validate derivation parameters
   */
  private validateDerivationParams(operation: HDOperation | string, index: number): void {
    const validOperations = Object.values(HDOperation);
    if (!validOperations.includes(operation as HDOperation)) {
      throw new LaserGunError(
        `Invalid operation ${operation}. Must be one of: ${validOperations.join(', ')}`,
        ErrorCode.CRYPTO_ERROR
      );
    }
    
    if (!Number.isInteger(index) || index < 0 || index > MAX_HD_INDEX) {
      throw new LaserGunError(
        `Invalid index ${index}. Must be integer between 0 and ${MAX_HD_INDEX}`,
        ErrorCode.CRYPTO_ERROR
      );
    }
  }
}