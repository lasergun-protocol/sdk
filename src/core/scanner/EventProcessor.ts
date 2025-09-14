import type { IStorageAdapter,  Transaction, HexString, ScannedBlockCallback, TransactionCallback } from '../../types';
import { CryptoService } from '../../crypto';
import { HDHelpers, ErrorHelpers, StorageHelpers } from '../../utils';

/**
 * Event processing module for LaserGun scanner
 * Handles individual event processing during ongoing monitoring
 */
export class EventProcessor {
  private readonly storage: IStorageAdapter;
  private readonly chainId: number;

  constructor(storage: IStorageAdapter, chainId: number) {
    this.storage = storage;
    this.chainId = chainId;
  }

  /**
   * Process incoming SecretDelivered event during ongoing scanning
   */
  async processIncomingSecretDelivered(
    event: any,
    wallet: string,
    keys: { privateKey: HexString },
    contract: any,
    transactionCallback?: (tx: Transaction) => void
  ): Promise<void> {
    try {
      const encryptedSecret = event.args.encryptedSecret;
      const secret = await CryptoService.decryptSecret(encryptedSecret, keys.privateKey);
      
      if (!secret) return; // Not for us
      
      const commitment = CryptoService.generateCommitment(secret, wallet);
      
      // Check if already processed
      const existingShield = await StorageHelpers.getShield(
        this.storage, this.chainId, wallet, commitment
      );
      if (existingShield) return;
      
      // Get shield info from contract
      const shieldInfo = await contract.getShieldInfo(commitment);
      if (!shieldInfo.exists || shieldInfo.spent) return;
      
      // Update received count
      const currentCounts = await StorageHelpers.loadEventCounts(
        this.storage, this.chainId, wallet, true
      );
      
      const newReceivedIndex = currentCounts!.received;
      
      // Create shield with HD metadata
      const shield = HDHelpers.createHDShield(
        secret,
        commitment,
        shieldInfo.token,
        shieldInfo.amount,
        'received',
        newReceivedIndex,
        event.transactionHash,
        event.blockNumber
      );

      await StorageHelpers.saveShield(this.storage, this.chainId, wallet, shield);
      
      // Update event counts
      const updatedCounts = HDHelpers.updateEventCounts(
        currentCounts!,
        'received',
        1,
        event.blockNumber
      );
      
      await StorageHelpers.saveEventCounts(
        this.storage, this.chainId, wallet, updatedCounts
      );
      
      const transaction = HDHelpers.createHDTransaction(
        newReceivedIndex,
        'received',
        event.transactionHash,
        event.blockNumber,
        shieldInfo.token,
        shieldInfo.amount,
        0n,
        commitment,
        'received',
        newReceivedIndex
      );

      await StorageHelpers.saveTransaction(
        this.storage, this.chainId, wallet, transaction
      );
      
      if (transactionCallback) {
        transactionCallback(transaction);
      }
      
      console.log(`✅ Processed incoming transfer: received/${newReceivedIndex}`);
      
    } catch (error) {
      throw ErrorHelpers.createError(
        error,
        'Failed to process incoming SecretDelivered event'
      );
    }
  }

  /**
   * Scan batch of blocks for new events (for ongoing monitoring)
   */
  async scanBatch(
    fromBlock: number,
    toBlock: number,
    contract: any,
    wallet: string,
    keys: { privateKey: HexString },
    transactionCallback?: TransactionCallback,
    blockScannedCallback?: ScannedBlockCallback
  ): Promise<void> {
    try {
      // For ongoing scanning, we primarily monitor SecretDelivered events
      const secretEvents = await contract.queryFilter(
        contract.filters.SecretDelivered(),
        fromBlock,
        toBlock
      );

      for (const event of secretEvents) {
        await this.processIncomingSecretDelivered(
          event, wallet, keys, contract, transactionCallback
        );
      }
      if (!!blockScannedCallback) blockScannedCallback(toBlock);
    } catch (error) {
      throw ErrorHelpers.createError(
        error,
        `Failed to scan batch ${fromBlock}-${toBlock}`
      );
    }
  }
}