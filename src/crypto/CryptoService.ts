import { keccak256, solidityPacked } from 'ethers';
import * as eccrypto from 'eccrypto';
import type { Signer } from 'ethers';
import type { CryptoKeys, HexString } from '../types';
import { LaserGunError, ErrorCode } from '../types';
import { HDSecretManager } from './HDSecretManager';

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