import type { 
    IStorageAdapter, 
    Shield, 
    EventCounts, 
    HexString, 
    ScannedBlockCallback
  } from '../../types';
  import { createEventCounts } from '../../types';
  import { CryptoService, HDSecretManager } from '../../crypto';
  import { HDHelpers,   StorageHelpers } from '../../utils';
  
  /**
   * HD Recovery module for blockchain data recovery
   * Handles sequential scanning with deterministic HD counting
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
      
      const recoveredShields: Shield[] = [];
      
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
                    if (shieldResult.shield) recoveredShields.push(shieldResult.shield);
                    shieldIndex++;
                  }
                  break;
  
                case 'SecretDelivered':
                  const receivedResult = await this.processSecretDeliveredEvent(
                    event, contract, keys, wallet, receivedIndex
                  );
                  if (receivedResult.isOurs) {
                    if (receivedResult.shield) recoveredShields.push(receivedResult.shield);
                    receivedIndex++;
                  }
                  break;
  
                case 'Unshielded':
                  const unshieldResult = await this.processUnshieldedEvent(
                    event, contract, hdManager, wallet, remainderIndex
                  );
                  if (unshieldResult.isOurs && unshieldResult.createdRemainder) {
                    if (unshieldResult.remainderShield) recoveredShields.push(unshieldResult.remainderShield);
                    remainderIndex++;
                  }
                  break;
  
                case 'ShieldConsolidated':
                  const consolidateResult = await this.processConsolidatedEvent(
                    event, contract, hdManager, wallet, consolidateIndex
                  );
                  if (consolidateResult.isOurs) {
                    if (consolidateResult.shield) recoveredShields.push(consolidateResult.shield);
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
  
      const eventCounts = createEventCounts({
        shield: shieldIndex,
        remainder: remainderIndex,
        received: receivedIndex,
        consolidate: consolidateIndex,
        lastUpdatedBlock: latestBlock
      });
  
      return { eventCounts, recoveredShields };
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
          
          const existingShield = await StorageHelpers.getShieldSafely(
            this.storage, this.chainId, wallet, actualCommitment
          );
          if (existingShield) return { isOurs: true };
  
          const shield = HDHelpers.createHDShield(
            expectedSecret,
            actualCommitment,
            event.args.token,
            event.args.amount.toString(),
            'shield',
            expectedIndex,
            event.transactionHash,
            event.blockNumber
          );
  
          await StorageHelpers.saveShieldSafely(this.storage, this.chainId, wallet, shield);
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
        
        const existingShield = await StorageHelpers.getShieldSafely(
          this.storage, this.chainId, wallet, commitment
        );
        if (existingShield) return { isOurs: true };
  
        const shieldInfo = await contract.getShieldInfo(commitment);
        
        if (shieldInfo.exists && !shieldInfo.spent) {
          const shield = HDHelpers.createHDShield(
            decryptedSecret,
            commitment,
            shieldInfo.token,
            shieldInfo.amount.toString(),
            'received',
            expectedIndex,
            event.transactionHash,
            event.blockNumber
          );
  
          await StorageHelpers.saveShieldSafely(this.storage, this.chainId, wallet, shield);
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
        
        const ourShield = await StorageHelpers.getShieldSafely(
          this.storage, this.chainId, wallet, unshieldedCommitment
        );
        
        if (!ourShield) return { isOurs: false, createdRemainder: false };
  
        console.log(`✅ Found our unshield operation for commitment: ${unshieldedCommitment}`);
        
        const expectedRemainderSecret = hdManager.deriveSecret('remainder', expectedRemainderIndex);
        const expectedRemainderCommitment = CryptoService.generateCommitment(expectedRemainderSecret, wallet);
        
        const remainderInfo = await contract.getShieldInfo(expectedRemainderCommitment);
        
        if (remainderInfo.exists && !remainderInfo.spent) {
          console.log(`✅ Found remainder shield: remainder/${expectedRemainderIndex}`);
          
          const existingRemainder = await StorageHelpers.getShieldSafely(
            this.storage, this.chainId, wallet, expectedRemainderCommitment
          );
          if (existingRemainder) return { isOurs: true, createdRemainder: true };
  
          const remainderShield = HDHelpers.createHDShield(
            expectedRemainderSecret,
            expectedRemainderCommitment,
            remainderInfo.token,
            remainderInfo.amount.toString(),
            'remainder',
            expectedRemainderIndex,
            event.transactionHash,
            event.blockNumber
          );
  
          await StorageHelpers.saveShieldSafely(this.storage, this.chainId, wallet, remainderShield);
          return { isOurs: true, createdRemainder: true, remainderShield };
        }
        
        return { isOurs: true, createdRemainder: false };
      } catch (error) {
        console.warn(`Failed to process Unshielded event:`, error);
        return { isOurs: false, createdRemainder: false };
      }
    }
  
    /**
     * Process ShieldConsolidated event with deterministic HD index
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
        
        const existingShield = await StorageHelpers.getShieldSafely(
          this.storage, this.chainId, wallet, newCommitment
        );
        if (existingShield) return { isOurs: true };
  
        const shieldInfo = await contract.getShieldInfo(newCommitment);
        
        if (shieldInfo.exists && !shieldInfo.spent) {
          const shield = HDHelpers.createHDShield(
            expectedSecret,
            newCommitment,
            shieldInfo.token,
            shieldInfo.amount.toString(),
            'consolidate',
            expectedIndex,
            event.transactionHash,
            event.blockNumber
          );
  
          await StorageHelpers.saveShieldSafely(this.storage, this.chainId, wallet, shield);
          return { isOurs: true, shield };
        }
  
        return { isOurs: false };
      } catch (error) {
        console.warn(`Failed to process ShieldConsolidated event:`, error);
        return { isOurs: false };
      }
    }
  }