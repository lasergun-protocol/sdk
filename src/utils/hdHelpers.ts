import type { EventCounts, HDOperation, HexString, Shield, Transaction } from '../types';
import { createEventCounts } from '../types';
import { CryptoService, HDSecretManager } from '../crypto';

/**
 * HD (Hierarchical Derivation) helper utilities
 * Common operations for HD secret management and transaction indexing
 */
export class HDHelpers {

  /**
   * Generate HD secret and commitment for operation
   */
  static generateHDSecretAndCommitment(
    hdManager: HDSecretManager,
    operation: HDOperation,
    index: number,
    wallet: string
  ): {
    secret: HexString;
    commitment: HexString;
    derivationPath: string;
  } {
    const secret = hdManager.deriveSecret(operation, index);
    const commitment = CryptoService.generateCommitment(secret, wallet);
    const derivationPath = `${operation}/${index}`;
    
    return { secret, commitment, derivationPath };
  }

  /**
   * Create HD metadata for shield
   */
  static createHDShield(
    secret: HexString,
    commitment: HexString,
    token: string,
    amount: string,
    operation: HDOperation,
    index: number,
    txHash?: string,
    blockNumber?: number
  ): Shield {
    return {
      secret,
      commitment,
      token,
      amount,
      timestamp: Date.now(),
      derivationPath: `${operation}/${index}`,
      hdIndex: index,
      hdOperation: operation,
      ...(txHash && { txHash }),
      ...(blockNumber && { blockNumber })
    };
  }

  /**
   * Create HD transaction record
   */
  static createHDTransaction(
    nonce: number,
    type: string,
    txHash: string,
    blockNumber: number,
    token: string,
    amount: string,
    fee: string,
    commitment?: string,
    operation?: HDOperation,
    index?: number,
    additionalFields?: Record<string, any>
  ): Transaction {
    const baseTransaction: Transaction = {
      nonce,
      type: type as any,
      txHash,
      blockNumber,
      timestamp: Date.now(),
      token,
      amount,
      fee,
      ...(commitment && { commitment }),
      ...(operation && index !== undefined && {
        derivationPath: `${operation}/${index}`,
        hdIndex: index,
        hdOperation: operation
      }),
      ...additionalFields
    };
    
    return baseTransaction;
  }

  /**
   * Update event counts with validation
   */
  static updateEventCounts(
    currentCounts: EventCounts,
    operation: HDOperation,
    increment: number = 1,
    blockNumber?: number
  ): EventCounts {
    const updates = {
      shield: currentCounts.shield + (operation === 'shield' ? increment : 0),
      remainder: currentCounts.remainder + (operation === 'remainder' ? increment : 0),
      received: currentCounts.received + (operation === 'received' ? increment : 0),
      consolidate: currentCounts.consolidate + (operation === 'consolidate' ? increment : 0),
      lastUpdatedBlock: blockNumber ? Math.max(blockNumber, currentCounts.lastUpdatedBlock) : currentCounts.lastUpdatedBlock
    };
    
    return createEventCounts(updates);
  }

  /**
   * Calculate next HD index for operation type
   */
  static getNextHDIndex(eventCounts: EventCounts, operation: HDOperation): number {
    switch (operation) {
      case 'shield':
        return eventCounts.shield;
      case 'remainder':
        return eventCounts.remainder;
      case 'received':
        return eventCounts.received;
      case 'consolidate':
        return eventCounts.consolidate;
      default:
        throw new Error(`Unknown HD operation: ${operation}`);
    }
  }

  /**
   * Calculate sequential operation index (for operations without specific HD type)
   */
  static getSequentialIndex(eventCounts: EventCounts): number {
    return eventCounts.shield + eventCounts.remainder + eventCounts.received + eventCounts.consolidate;
  }

  /**
   * Get HD operation priority (for sorting)
   */
  static getOperationPriority(operation: HDOperation): number {
    const priorities = {
      'shield': 1,
      'remainder': 2,
      'received': 3,
      'consolidate': 4
    };
    return priorities[operation] || 999;
  }

  /**
   * Validate HD derivation path format
   */
  static parseDerivationPath(path: string): { operation: HDOperation; index: number } {
    const parts = path.split('/');
    if (parts.length !== 2) {
      throw new Error(`Invalid derivation path format: ${path}`);
    }
    
    const [operation, indexStr] = parts;
    const index = parseInt(indexStr, 10);
    
    if (isNaN(index) || index < 0) {
      throw new Error(`Invalid index in derivation path: ${path}`);
    }
    
    if (!['shield', 'remainder', 'received', 'consolidate'].includes(operation)) {
      throw new Error(`Invalid operation in derivation path: ${path}`);
    }
    
    return { operation: operation as HDOperation, index };
  }

  /**
   * Compare event counts for changes
   */
  static compareEventCounts(
    oldCounts: EventCounts, 
    newCounts: EventCounts
  ): {
    hasChanges: boolean;
    changes: Partial<Record<HDOperation, number>>;
  } {
    const changes: Partial<Record<HDOperation, number>> = {};
    let hasChanges = false;
    
    if (oldCounts.shield !== newCounts.shield) {
      changes.shield = newCounts.shield - oldCounts.shield;
      hasChanges = true;
    }
    
    if (oldCounts.remainder !== newCounts.remainder) {
      changes.remainder = newCounts.remainder - oldCounts.remainder;
      hasChanges = true;
    }
    
    if (oldCounts.received !== newCounts.received) {
      changes.received = newCounts.received - oldCounts.received;
      hasChanges = true;
    }
    
    if (oldCounts.consolidate !== newCounts.consolidate) {
      changes.consolidate = newCounts.consolidate - oldCounts.consolidate;
      hasChanges = true;
    }
    
    return { hasChanges, changes };
  }

  /**
   * Generate multiple HD secrets efficiently
   */
  static *generateMultipleSecrets(
    hdManager: HDSecretManager,
    operation: HDOperation,
    startIndex: number,
    count: number,
    wallet: string
  ): Generator<{
    secret: HexString;
    commitment: HexString;
    derivationPath: string;
    index: number;
  }> {
    for (let i = 0; i < count; i++) {
      const index = startIndex + i;
      const { secret, commitment, derivationPath } = HDHelpers.generateHDSecretAndCommitment(
        hdManager, 
        operation, 
        index, 
        wallet
      );
      
      yield { secret, commitment, derivationPath, index };
    }
  }

  /**
   * Create default event counts for new wallet
   */
  static createDefaultEventCounts(lastUpdatedBlock: number = 0): EventCounts {
    return createEventCounts({
      shield: 0,
      remainder: 0,
      received: 0,
      consolidate: 0,
      lastUpdatedBlock
    });
  }

  /**
   * Merge event counts from multiple sources
   */
  static mergeEventCounts(counts: EventCounts[]): EventCounts {
    if (counts.length === 0) {
      return HDHelpers.createDefaultEventCounts();
    }
    
    const merged = {
      shield: Math.max(...counts.map(c => c.shield)),
      remainder: Math.max(...counts.map(c => c.remainder)),
      received: Math.max(...counts.map(c => c.received)),
      consolidate: Math.max(...counts.map(c => c.consolidate)),
      lastUpdatedBlock: Math.max(...counts.map(c => c.lastUpdatedBlock))
    };
    
    return createEventCounts(merged);
  }
}