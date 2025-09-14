import type { 
  IStorageAdapter, 
  Shield, 
  EventCounts, 
  HexString, 
  ScannedBlockCallback,
  Transaction
} from '../../types';
import { createEventCounts } from '../../types';
import { CryptoService, HDSecretManager } from '../../crypto';
import { HDHelpers, StorageHelpers } from '../../utils';

/**
 * HD Recovery module for blockchain data recovery
 * Handles sequential scanning with deterministic HD counting
 * ИСПРАВЛЕНО: Сохраняет транзакции с правильными nonce и Event counts
 */
export class HDRecovery {
  private readonly storage: IStorageAdapter;
  private readonly chainId: number;
  private readonly batchSize: number;

  constructor(storage: IStorageAdapter, chainId: number, batchSize: number = 1000) {
    this.storage = storage;
    this.chainId = chainId;
    this.batchSize = batchSize;
  }

  /**
   * Sequential scan of blockchain with deterministic HD counting
   * ИСПРАВЛЕНО: Правильные nonce для всех операций + Event counts синхронизация
   */
  async sequentialScan(
    contract: any,
    provider: any,
    hdManager: HDSecretManager,
    wallet: string,
    keys: { privateKey: HexString },
    startBlock: number,
    blockScannedCallback?: ScannedBlockCallback
  ): Promise<{
    eventCounts: EventCounts;
    recoveredShields: Shield[];
  }> {
    const latestBlock = await provider.getBlockNumber();
    
    // Initialize counters
    let shieldIndex = 0;
    let remainderIndex = 0;
    let receivedIndex = 0;
    let consolidateIndex = 0;
    
    // Текущие event counts для правильного sequential nonce
    let currentEventCounts = HDHelpers.createDefaultEventCounts(startBlock);
    
    const recoveredShields: Shield[] = [];
    const pendingTransactions: Transaction[] = [];
    
    console.log(`🔍 Sequential scan from block ${startBlock} to ${latestBlock}...`);

    // Process blocks in sequential batches
    for (let blockStart = startBlock; blockStart <= latestBlock; blockStart += this.batchSize) {
      const blockEnd = Math.min(blockStart + this.batchSize - 1, latestBlock);
      
      console.log(`📦 Processing blocks ${blockStart}-${blockEnd}...`);
      
      try {
        const allEvents = await this.getAndSortEvents(contract, blockStart, blockEnd);
        if (blockScannedCallback) blockScannedCallback(blockEnd);
        
        // Process events sequentially
        for (const event of allEvents) {
          try {
            switch (event.eventType) {
              case 'Shielded':
                const shieldResult = await this.processShieldedEvent(
                  event, hdManager, wallet, shieldIndex
                );
                if (shieldResult.isOurs) {
                  if (shieldResult.shield) {
                    recoveredShields.push(shieldResult.shield);
                    // Создаем транзакцию с правильным nonce
                    const transaction = this.createShieldTransaction(event, shieldIndex, shieldResult.shield);
                    pendingTransactions.push(transaction);
                    
                    // Обновляем counts
                    currentEventCounts = HDHelpers.updateEventCounts(currentEventCounts, 'shield', 1, event.blockNumber);
                  }
                  shieldIndex++;
                }
                break;

              case 'SecretDelivered':
                const receivedResult = await this.processSecretDeliveredEvent(
                  event, contract, keys, wallet, receivedIndex
                );
                if (receivedResult.isOurs) {
                  if (receivedResult.shield) {
                    recoveredShields.push(receivedResult.shield);
                    // Создаем транзакцию с правильным nonce
                    const transaction = this.createReceivedTransaction(event, receivedIndex, receivedResult.shield);
                    pendingTransactions.push(transaction);
                    
                    // Обновляем counts
                    currentEventCounts = HDHelpers.updateEventCounts(currentEventCounts, 'received', 1, event.blockNumber);
                  }
                  receivedIndex++;
                }
                break;

              case 'Unshielded':
                const unshieldResult = await this.processUnshieldedEvent(
                  event, contract, hdManager, wallet, remainderIndex
                );
                if (unshieldResult.isOurs) {
                  // Создаем unshield транзакцию с правильным sequential nonce
                  const unshieldTx = this.createUnshieldTransaction(event, currentEventCounts);
                  pendingTransactions.push(unshieldTx);
                  
                  // Unshield не обновляет HD counts - это non-HD операция
                  
                  if (unshieldResult.createdRemainder && unshieldResult.remainderShield) {
                    recoveredShields.push(unshieldResult.remainderShield);
                    // Создаем remainder транзакцию с HD nonce
                    const remainderTx = this.createRemainderTransaction(event, remainderIndex, unshieldResult.remainderShield);
                    pendingTransactions.push(remainderTx);
                    remainderIndex++;
                    
                    // Обновляем counts для remainder
                    currentEventCounts = HDHelpers.updateEventCounts(currentEventCounts, 'remainder', 1, event.blockNumber);
                  }
                }
                break;

              case 'ShieldConsolidated':
                const consolidateResult = await this.processConsolidatedEvent(
                  event, contract, hdManager, wallet, consolidateIndex
                );
                if (consolidateResult.isOurs) {
                  if (consolidateResult.shield) {
                    recoveredShields.push(consolidateResult.shield);
                    // Создаем транзакцию с правильным nonce
                    const transaction = this.createConsolidateTransaction(event, consolidateIndex, consolidateResult.shield);
                    pendingTransactions.push(transaction);
                    
                    // Обновляем counts
                    currentEventCounts = HDHelpers.updateEventCounts(currentEventCounts, 'consolidate', 1, event.blockNumber);
                  }
                  consolidateIndex++;
                }
                break;
            }
          } catch (error) {
            console.warn(`⚠️ Failed to process event at block ${event.blockNumber}:`, error);
          }
        }
        
      } catch (error) {
        console.error(`❌ Failed to process batch ${blockStart}-${blockEnd}:`, error);
      }
      
      // Small delay to prevent rate limiting
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Batch save все транзакции
    await this.batchSaveTransactions(pendingTransactions, wallet);

    // Финальные event counts с правильными значениями
    const finalEventCounts = createEventCounts({
      shield: shieldIndex,
      remainder: remainderIndex,
      received: receivedIndex,
      consolidate: consolidateIndex,
      lastUpdatedBlock: latestBlock
    });

    // Сохраняем финальные event counts
    await StorageHelpers.saveEventCounts(this.storage, this.chainId, wallet, finalEventCounts);

    return { eventCounts: finalEventCounts, recoveredShields };
  }

  /**
   * ИСПРАВЛЕНО: Создание транзакции shield с правильным nonce
   */
  private createShieldTransaction(event: any, hdIndex: number, shield: Shield): Transaction {
    return HDHelpers.createHDTransaction(
      hdIndex, // Правильный HD nonce
      'shield',
      event.transactionHash,
      event.blockNumber,
      shield.token,
      shield.amount,
      event.args.fee || 0n,
      shield.commitment,
      'shield',
      hdIndex
    );
  }

  /**
   * ИСПРАВЛЕНО: Создание транзакции received с правильным nonce
   */
  private createReceivedTransaction(event: any, hdIndex: number, shield: Shield): Transaction {
    return HDHelpers.createHDTransaction(
      hdIndex, // Правильный HD nonce
      'received',
      event.transactionHash,
      event.blockNumber,
      shield.token,
      shield.amount,
      0n,
      shield.commitment,
      'received',
      hdIndex
    );
  }

  /**
   * ИСПРАВЛЕНО: Создание транзакции unshield с правильным sequential nonce
   */
  private createUnshieldTransaction(event: any, currentEventCounts: EventCounts): Transaction {
    const sequentialNonce = HDHelpers.getSequentialIndex(currentEventCounts);
    return HDHelpers.createHDTransaction(
      sequentialNonce,
      'unshield',
      event.transactionHash,
      event.blockNumber,
      event.args.token,
      event.args.amount,
      event.args.fee || 0n,
      event.args.commitment,
      undefined,
      undefined,
      { from: event.args.commitment }
    );
  }

  /**
   * ИСПРАВЛЕНО: Создание транзакции remainder с правильным HD nonce
   */
  private createRemainderTransaction(event: any, hdIndex: number, remainderShield: Shield): Transaction {
    return HDHelpers.createHDTransaction(
      hdIndex, // Правильный HD nonce
      'remainder',
      event.transactionHash,
      event.blockNumber,
      remainderShield.token,
      remainderShield.amount,
      0n,
      remainderShield.commitment,
      'remainder',
      hdIndex
    );
  }

  /**
   * ИСПРАВЛЕНО: Создание транзакции consolidate с правильным nonce
   */
  private createConsolidateTransaction(event: any, hdIndex: number, shield: Shield): Transaction {
    return HDHelpers.createHDTransaction(
      hdIndex, // Правильный HD nonce
      'consolidate',
      event.transactionHash,
      event.blockNumber,
      shield.token,
      shield.amount,
      0n,
      shield.commitment,
      'consolidate',
      hdIndex
    );
  }

  /**
   * ДОБАВЛЕНО: Batch сохранение транзакций с проверкой дубликатов
   */
  private async batchSaveTransactions(transactions: Transaction[], wallet: string): Promise<void> {
    if (transactions.length === 0) return;

    console.log(`💾 Batch saving ${transactions.length} transactions...`);
    
    let saved = 0;
    let skipped = 0;
    let failed = 0;

    for (const transaction of transactions) {
      try {
        // Проверяем существование транзакции
        const existing = await this.storage.getTransaction(this.chainId, wallet, transaction.nonce);
        if (existing) {
          skipped++;
          continue;
        }

        await StorageHelpers.saveTransaction(this.storage, this.chainId, wallet, transaction);
        saved++;
      } catch (error) {
        console.warn(`Failed to save transaction ${transaction.txHash}:`, error);
        failed++;
      }
    }

    console.log(`📊 Transaction save results: ${saved} saved, ${skipped} skipped, ${failed} failed`);
  }

  /**
   * Get and sort all events from block range
   */
  private async getAndSortEvents(contract: any, blockStart: number, blockEnd: number) {
    const [shieldedEvents, unshieldedEvents, secretEvents, consolidatedEvents] = await Promise.all([
      contract.queryFilter(contract.filters.Shielded(), blockStart, blockEnd),
      contract.queryFilter(contract.filters.Unshielded(), blockStart, blockEnd),
      contract.queryFilter(contract.filters.SecretDelivered(), blockStart, blockEnd),
      contract.queryFilter(contract.filters.ShieldConsolidated(), blockStart, blockEnd)
    ]);

    // Combine and sort all events
    return [
      ...shieldedEvents.map((e: any) => ({ ...e, eventType: 'Shielded' as const })),
      ...unshieldedEvents.map((e: any) => ({ ...e, eventType: 'Unshielded' as const })),
      ...secretEvents.map((e: any) => ({ ...e, eventType: 'SecretDelivered' as const })),
      ...consolidatedEvents.map((e: any) => ({ ...e, eventType: 'ShieldConsolidated' as const }))
    ].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
      return (a.transactionIndex - b.transactionIndex) || (a.index - b.index);
    });
  }

  /**
   * Process Shielded event with deterministic HD index
   * ИСПРАВЛЕНО: Убрано сохранение, только возврат данных
   */
  private async processShieldedEvent(
    event: any, 
    hdManager: HDSecretManager, 
    wallet: string, 
    expectedIndex: number
  ) {
    try {
      const expectedSecret = hdManager.deriveSecret('shield', expectedIndex);
      const expectedCommitment = CryptoService.generateCommitment(expectedSecret, wallet);
      const actualCommitment = event.args.commitment;

      if (expectedCommitment === actualCommitment) {
        console.log(`✅ Found our shield operation: shield/${expectedIndex}`);
        
        // Проверяем существование
        const existingShield = await StorageHelpers.getShield(
          this.storage, this.chainId, wallet, actualCommitment
        );
        if (existingShield) return { isOurs: true };

        const shield = HDHelpers.createHDShield(
          expectedSecret,
          actualCommitment,
          event.args.token,
          event.args.amount,
          'shield',
          expectedIndex,
          event.transactionHash,
          event.blockNumber
        );

        // Сохраняем только shield
        await StorageHelpers.saveShield(this.storage, this.chainId, wallet, shield);
        return { isOurs: true, shield };
      }

      return { isOurs: false };
    } catch (error) {
      console.warn(`Failed to process Shielded event:`, error);
      return { isOurs: false };
    }
  }

  /**
   * Process SecretDelivered event with deterministic HD index
   * ИСПРАВЛЕНО: Убрано сохранение, только возврат данных
   */
  private async processSecretDeliveredEvent(
    event: any,
    contract: any,
    keys: { privateKey: HexString },
    wallet: string,
    expectedIndex: number
  ) {
    try {
      const encryptedSecret = event.args.encryptedSecret;
      const decryptedSecret = await CryptoService.decryptSecret(encryptedSecret, keys.privateKey);
      
      if (!decryptedSecret) return { isOurs: false };

      console.log(`✅ Found received transfer: received/${expectedIndex}`);
      
      const commitment = CryptoService.generateCommitment(decryptedSecret, wallet);
      
      // Проверяем существование
      const existingShield = await StorageHelpers.getShield(
        this.storage, this.chainId, wallet, commitment
      );
      if (existingShield) return { isOurs: true };

      const shieldInfo = await contract.getShieldInfo(commitment);
      
      if (shieldInfo.exists && !shieldInfo.spent) {
        const shield = HDHelpers.createHDShield(
          decryptedSecret,
          commitment,
          shieldInfo.token,
          shieldInfo.amount,
          'received',
          expectedIndex,
          event.transactionHash,
          event.blockNumber
        );

        // Сохраняем только shield
        await StorageHelpers.saveShield(this.storage, this.chainId, wallet, shield);
        return { isOurs: true, shield };
      }

      return { isOurs: false };
    } catch (error) {
      console.warn(`Failed to process SecretDelivered event:`, error);
      return { isOurs: false };
    }
  }

  /**
   * Process Unshielded event and check if remainder was created
   * ИСПРАВЛЕНО: Возвращает sourceShield для создания транзакции
   */
  private async processUnshieldedEvent(
    event: any,
    contract: any,
    hdManager: HDSecretManager,
    wallet: string,
    expectedRemainderIndex: number
  ) {
    try {
      const unshieldedCommitment = event.args.commitment;
      
      const sourceShield = await StorageHelpers.getShield(
        this.storage, this.chainId, wallet, unshieldedCommitment
      );
      
      if (!sourceShield) return { isOurs: false, createdRemainder: false };

      console.log(`✅ Found our unshield operation for commitment: ${unshieldedCommitment}`);
      
      const expectedRemainderSecret = hdManager.deriveSecret('remainder', expectedRemainderIndex);
      const expectedRemainderCommitment = CryptoService.generateCommitment(expectedRemainderSecret, wallet);
      
      const remainderInfo = await contract.getShieldInfo(expectedRemainderCommitment);
      
      if (remainderInfo.exists && !remainderInfo.spent) {
        console.log(`✅ Found remainder shield: remainder/${expectedRemainderIndex}`);
        
        // Проверяем существование
        const existingRemainder = await StorageHelpers.getShield(
          this.storage, this.chainId, wallet, expectedRemainderCommitment
        );
        if (existingRemainder) return { 
          isOurs: true, 
          createdRemainder: true,
          sourceShield
        };

        const remainderShield = HDHelpers.createHDShield(
          expectedRemainderSecret,
          expectedRemainderCommitment,
          remainderInfo.token,
          remainderInfo.amount,
          'remainder',
          expectedRemainderIndex,
          event.transactionHash,
          event.blockNumber
        );

        // Сохраняем только remainder shield
        await StorageHelpers.saveShield(this.storage, this.chainId, wallet, remainderShield);
        return { 
          isOurs: true, 
          createdRemainder: true, 
          remainderShield,
          sourceShield
        };
      }
      
      return { 
        isOurs: true, 
        createdRemainder: false,
        sourceShield
      };
    } catch (error) {
      console.warn(`Failed to process Unshielded event:`, error);
      return { isOurs: false, createdRemainder: false };
    }
  }

  /**
   * Process ShieldConsolidated event with deterministic HD index
   * ИСПРАВЛЕНО: Убрано сохранение, только возврат данных
   */
  private async processConsolidatedEvent(
    event: any,
    contract: any,
    hdManager: HDSecretManager,
    wallet: string,
    expectedIndex: number
  ) {
    try {
      const newCommitment = event.args.newCommitment;
      
      const expectedSecret = hdManager.deriveSecret('consolidate', expectedIndex);
      const expectedCommitment = CryptoService.generateCommitment(expectedSecret, wallet);

      if (expectedCommitment !== newCommitment) return { isOurs: false };

      console.log(`✅ Found our consolidation: consolidate/${expectedIndex}`);
      
      // Проверяем существование
      const existingShield = await StorageHelpers.getShield(
        this.storage, this.chainId, wallet, newCommitment
      );
      if (existingShield) return { isOurs: true };

      const shieldInfo = await contract.getShieldInfo(newCommitment);
      
      if (shieldInfo.exists && !shieldInfo.spent) {
        const shield = HDHelpers.createHDShield(
          expectedSecret,
          newCommitment,
          shieldInfo.token,
          shieldInfo.amount,
          'consolidate',
          expectedIndex,
          event.transactionHash,
          event.blockNumber
        );

        // Сохраняем только shield
        await StorageHelpers.saveShield(this.storage, this.chainId, wallet, shield);
        return { isOurs: true, shield };
      }

      return { isOurs: false };
    } catch (error) {
      console.warn(`Failed to process ShieldConsolidated event:`, error);
      return { isOurs: false };
    }
  }
}