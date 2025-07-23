import { keccak256, solidityPacked } from 'ethers';
import * as eccrypto from 'eccrypto';
import type { Signer } from 'ethers';
import type { CryptoKeys, HexString } from '../types';
import { LaserGunError, ErrorCode } from '../types';

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
   * @param operation - Type of operation (must be valid HDOperation)
   * @param index - Index within operation type (0 to MAX_HD_INDEX)
   * @returns Deterministic secret for this path
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
   * @param operation - Operation type
   * @param count - Number of secrets to generate (max MAX_HD_INDEX)
   * @returns Generator for memory-efficient processing
   */
  *deriveMultipleSecrets(operation: HDOperation | string, count: number): Generator<{secret: HexString, index: number, path: string}> {
    this.validateDerivationParams(operation, 0); // Validate operation
    
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
   * @param path - Full path like "shield/5" or "remainder/2"
   * @returns Secret for this exact path
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
   * Validate derivation parameters
   */
  private validateDerivationParams(operation: HDOperation | string, index: number): void {
    // Validate operation
    const validOperations = Object.values(HDOperation);
    if (!validOperations.includes(operation as HDOperation)) {
      throw new LaserGunError(
        `Invalid operation ${operation}. Must be one of: ${validOperations.join(', ')}`,
        ErrorCode.CRYPTO_ERROR
      );
    }
    
    // Validate index
    if (!Number.isInteger(index) || index < 0 || index > MAX_HD_INDEX) {
      throw new LaserGunError(
        `Invalid index ${index}. Must be integer between 0 and ${MAX_HD_INDEX}`,
        ErrorCode.CRYPTO_ERROR
      );
    }
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
}

/**
 * Enhanced crypto service with HD derivation support
 * Handles ECIES encryption, key generation, and HD secret management
 */
export class CryptoService {
  private static readonly DEFAULT_SIGN_MESSAGE = '\x19Ethereum Signed Message:\nLaserGun Key';

  /**
   * Generate deterministic ECIES keys from wallet signature
   */
  static async generateKeys(
    signer: Signer,
    chainId: number,
    keyNonce: number = 0,
    customMessage?: string
  ): Promise<CryptoKeys> {
    try {
      const wallet = await signer.getAddress();
      const message = customMessage || 
        `${this.DEFAULT_SIGN_MESSAGE}: \nChain: ${chainId}\nWallet: ${wallet}\nNonce: ${keyNonce}`;
      
      const signature = await signer.signMessage(message);
      const hash = keccak256(signature);
      
      // Use hash as private key (first 32 bytes)
      const privateKey = hash.slice(0, 66); // 0x + 64 chars
      const publicKey = eccrypto.getPublic(Buffer.from(privateKey.slice(2), 'hex'));
      
      return {
        privateKey,
        publicKey: '0x' + publicKey.toString('hex'),
        keyNonce
      };
    } catch (error) {
      throw new LaserGunError(
        `Failed to generate keys: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.CRYPTO_ERROR,
        error
      );
    }
  }

  /**
   * Create HD Secret Manager instance with validation
   */
  static createHDManager(privateKey: HexString, walletAddress: string, chainId: number): HDSecretManager {
    try {
      return new HDSecretManager(privateKey, walletAddress, chainId);
    } catch (error) {
      throw new LaserGunError(
        `Failed to create HD manager: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.CRYPTO_ERROR,
        error
      );
    }
  }

  /**
   * Encrypt secret for recipient using ECIES
   */
  static async encryptSecret(secret: HexString, recipientPublicKey: HexString): Promise<string> {
    try {
      const secretBuffer = Buffer.from(secret.slice(2), 'hex');
      const publicKeyBuffer = Buffer.from(recipientPublicKey.slice(2), 'hex');
      
      const encrypted = await eccrypto.encrypt(publicKeyBuffer, secretBuffer);
      
      // Serialize encrypted data
      const serialized = {
        iv: encrypted.iv.toString('hex'),
        ephemPublicKey: encrypted.ephemPublicKey.toString('hex'),
        ciphertext: encrypted.ciphertext.toString('hex'),
        mac: encrypted.mac.toString('hex')
      };
      
      return '0x' + Buffer.from(JSON.stringify(serialized)).toString('hex');
    } catch (error) {
      throw new LaserGunError(
        `Failed to encrypt secret: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.CRYPTO_ERROR,
        error
      );
    }
  }

  /**
   * Decrypt secret using private key
   */
  static async decryptSecret(encryptedData: string, privateKey: HexString): Promise<HexString | null> {
    try {
      const dataBuffer = Buffer.from(encryptedData.slice(2), 'hex');
      const serialized = JSON.parse(dataBuffer.toString());
      
      const encrypted = {
        iv: Buffer.from(serialized.iv, 'hex'),
        ephemPublicKey: Buffer.from(serialized.ephemPublicKey, 'hex'),
        ciphertext: Buffer.from(serialized.ciphertext, 'hex'),
        mac: Buffer.from(serialized.mac, 'hex')
      };
      
      const privateKeyBuffer = Buffer.from(privateKey.slice(2), 'hex');
      const decrypted = await eccrypto.decrypt(privateKeyBuffer, encrypted);
      
      return `0x${decrypted.toString('hex')}`;
    } catch (error) {
      // Return null if decryption fails (not our secret)
      return null;
    }
  }

  /**
   * Generate commitment hash from secret and recipient
   */
  static generateCommitment(secret: HexString, recipient: string): HexString {
    try {
      return keccak256(solidityPacked(['bytes32', 'address'], [secret, recipient])) as HexString;
    } catch (error) {
      throw new LaserGunError(
        `Failed to generate commitment: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.CRYPTO_ERROR,
        error
      );
    }
  }

  /**
   * Generate deterministic commitment for sender (for remainder shields)
   * NOTE: This is kept for compatibility with contract's generateSenderCommitment
   */
  static generateSenderCommitment(sender: string, nonce: number): HexString {
    try {
      return keccak256(solidityPacked(['address', 'uint256'], [sender, nonce])) as HexString;
    } catch (error) {
      throw new LaserGunError(
        `Failed to generate sender commitment: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.CRYPTO_ERROR,
        error
      );
    }
  }

  /**
   * @deprecated Use HDSecretManager.deriveSecret instead
   * Generate secret using old nonce-based method (kept for compatibility)
   */
  static generateSecret(privateKey: HexString, nonce: number): HexString {
    try {
      return keccak256(solidityPacked(['bytes32', 'uint256'], [privateKey, nonce])) as HexString;
    } catch (error) {
      throw new LaserGunError(
        `Failed to generate secret: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.CRYPTO_ERROR,
        error
      );
    }
  }

  /**
   * Validate hex string format
   */
  static isValidHexString(value: string): value is HexString {
    return /^0x[0-9a-fA-F]+$/.test(value);
  }

  /**
   * Validate Ethereum address format
   */
  static isValidAddress(address: string): boolean {
    return /^0x[0-9a-fA-F]{40}$/.test(address);
  }

  /**
   * Convert Buffer to hex string
   */
  static bufferToHex(buffer: Buffer): HexString {
    return ('0x' + buffer.toString('hex')) as HexString;
  }

  /**
   * Convert hex string to Buffer
   */
  static hexToBuffer(hex: HexString): Buffer {
    return Buffer.from(hex.slice(2), 'hex');
  }
}