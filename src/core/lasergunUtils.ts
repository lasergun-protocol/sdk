import type { IStorageAdapter, CryptoKeys, EventCounts } from '../types';
import {  ErrorHelpers } from '../utils';

/**
 * LaserGun utility functions
 * Extracted from main class to reduce file size
 */
export class LaserGunUtils {

  /**
   * Load or initialize keys for wallet
   */
  static async loadOrSaveKeys(
    storage: IStorageAdapter,
    chainId: number,
    wallet: string,
    keys: CryptoKeys
  ): Promise<CryptoKeys> {
    try {
      const savedKeys = await storage.loadKeys(chainId, wallet);
      if (savedKeys) {
        return savedKeys;
      } else {
        await storage.saveKeys(chainId, wallet, keys);
        return keys;
      }
    } catch (error) {
      throw ErrorHelpers.storageError(
        'load or save keys',
        ErrorHelpers.getErrorMessage(error)
      );
    }
  }

  /**
   * Initialize default event counts if not found
   */
  static createDefaultEventCounts(): EventCounts {
    return {
      shield: 0,
      remainder: 0,
      received: 0,
      consolidate: 0,
      lastUpdatedBlock: 0
    };
  }

  /**
   * Validate LaserGun initialization state
   */
  static validateInitialization(
    wallet: string,
    keys: CryptoKeys | null,
    hdManager: any
  ): void {
    if (!wallet || !keys || !hdManager) {
      throw ErrorHelpers.initializationError(
        'LaserGun',
        'Call initialize() first'
      );
    }
  }

  /**
   * Get storage context for operations
   */
  static getStorageContext(chainId: number, wallet: string): {
    chainId: number;
    wallet: string;
  } {
    return { chainId, wallet };
  }
}