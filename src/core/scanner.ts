import type { Provider } from 'ethers';
import { Contract } from 'ethers';
import type { 
  IStorageAdapter, 
  ScannerConfig, 
  ScannerState, 
  TransactionCallback, 
  ErrorCallback, 
  StateChangeCallback, 
  Transaction,
  CryptoKeys,
  HexString,
  Shield,
  EventCounts 
} from '../types';
import { LaserGunError, ErrorCode, createEventCounts } from '../types';
import { CryptoService, HDSecretManager } from '../crypto';
 

/**
 * Event scanner for LaserGun contract with HD derivation support
 * Uses sequential block scanning with deterministic HD index counting
 */
export class EventScanner {
  private readonly contract: Contract;
  private readonly provider: Provider;
  private readonly storage: IStorageAdapter;
  private readonly chainId: number;
  private readonly batchSize: number;
  private readonly startBlock: number;
  private readonly enableHDRecovery: boolean;

  private wallet: string = '';
  private keys: CryptoKeys | null = null;
  private hdManager: HDSecretManager | null = null;
  private isRunning: boolean = false;
  private currentBlock: number = 0;
  private lastScannedBlock: number = 0;
  private scanningPromise: Promise<void> | null = null;
  private eventCounts: EventCounts | null = null;

  // Callbacks
  private transactionCallback?: TransactionCallback;
  private errorCallback?: ErrorCallback;
  private stateChangeCallback?: StateChangeCallback;

  // LaserGun contract ABI (only events we need)
  private static readonly CONTRACT_ABI = [
    'event Shielded(bytes32 indexed commitment, address indexed token, uint256 amount, uint256 fee)',
    'event Unshielded(bytes32 indexed commitment, address indexed token, uint256 amount, uint256 fee)',
    'event SecretDelivered(bytes encryptedSecret)',
    'event ShieldConsolidated(bytes32[] indexed oldCommitments, bytes32 indexed newCommitment)',
    // View functions for shield info
    'function getShieldInfo(bytes32 commitment) external view returns (bool exists, address token, uint256 amount, uint256 timestamp, bool spent)'
  ];

  constructor(
    contractAddress: string,
    provider: Provider,
    storage: IStorageAdapter,
    chainId: number,
    config: ScannerConfig = {}
  ) {
    this.contract = new Contract(contractAddress, EventScanner.CONTRACT_ABI, provider);
    this.provider = provider;
    this.storage = storage;
    this.chainId = chainId;
    this.batchSize = config.batchSize || 1000; // Smaller batches for sequential processing
    this.startBlock = config.startBlock || 0;
    this.enableHDRecovery = config.enableHDRecovery ?? true;
  }

  /**
   * Initialize scanner for specific wallet
   */
  async initialize(wallet: string, keys: CryptoKeys): Promise<void> {
    try {
      if (!wallet || typeof wallet !== 'string') {
        throw new LaserGunError('Invalid wallet address', ErrorCode.VALIDATION_ERROR);
      }
      
      if (!keys || !keys.privateKey) {
        throw new LaserGunError('Invalid crypto keys', ErrorCode.VALIDATION_ERROR);
      }

      this.wallet = wallet.toLowerCase();
      this.keys = keys;
      this.hdManager = CryptoService.createHDManager(
        keys.privateKey as HexString,
        this.wallet,
        this.chainId
      );
      
      this.lastScannedBlock = await this.storage.getLastScannedBlock(this.chainId, this.wallet) || 0;
      this.eventCounts = await this.storage.loadEventCounts(this.chainId, this.wallet);
      
      this.emitStateChange();
    } catch (error) {
      throw new LaserGunError(
        `Failed to initialize scanner: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.SCANNER_ERROR,
        error
      );
    }
  }

  /**
   * Perform sequential HD recovery from blockchain
   * Scans blocks sequentially and counts HD operations in order
   */
  async recoverFromBlockchain(): Promise<void> {
    if (!this.wallet || !this.keys || !this.hdManager) {
      throw new LaserGunError('Scanner not initialized', ErrorCode.SCANNER_ERROR);
    }

    try {
      console.log('🔍 Starting sequential HD recovery...');
      
      // Step 1: Sequential scan to count operations and recover shields
      const { eventCounts, recoveredShields } = await this.sequentialScan();
      
      console.log('📊 Final event counts:', eventCounts);
      console.log(`✅ Recovered ${recoveredShields.length} shields`);
      
      // Step 2: Save updated event counts
      await this.storage.saveEventCounts(this.chainId, this.wallet, eventCounts);
      this.eventCounts = eventCounts;
      
      this.emitStateChange();
      
    } catch (error) {
      throw new LaserGunError(
        `Failed to recover from blockchain: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.SCANNER_ERROR,
        error
      );
    }
  }

  /**
   * Sequential scan of blockchain with deterministic HD counting
   */
  private async sequentialScan(): Promise<{
    eventCounts: EventCounts;
    recoveredShields: Shield[];
  }> {
    const latestBlock = await this.provider.getBlockNumber();
    const fromBlock = this.startBlock;
    
    // Initialize counters
    let shieldIndex = 0;
    let remainderIndex = 0;
    let receivedIndex = 0;
    let consolidateIndex = 0;
    
    const recoveredShields: Shield[] = [];
    
    console.log(`🔍 Sequential scan from block ${fromBlock} to ${latestBlock}...`);

    // Process blocks in sequential batches
    for (let blockStart = fromBlock; blockStart <= latestBlock; blockStart += this.batchSize) {
      const blockEnd = Math.min(blockStart + this.batchSize - 1, latestBlock);
      
      console.log(`📦 Processing blocks ${blockStart}-${blockEnd}...`);
      
      try {
        // Get all events in this batch
        const [shieldedEvents, unshieldedEvents, secretEvents, consolidatedEvents] = await Promise.all([
          this.contract.queryFilter(this.contract.filters.Shielded(), blockStart, blockEnd),
          this.contract.queryFilter(this.contract.filters.Unshielded(), blockStart, blockEnd),
          this.contract.queryFilter(this.contract.filters.SecretDelivered(), blockStart, blockEnd),
          this.contract.queryFilter(this.contract.filters.ShieldConsolidated(), blockStart, blockEnd)
        ]);

        // Combine and sort all events by block number and transaction index
        const allEvents = [
          ...shieldedEvents.map(e => ({ ...e, eventType: 'Shielded' as const })),
          ...unshieldedEvents.map(e => ({ ...e, eventType: 'Unshielded' as const })),
          ...secretEvents.map(e => ({ ...e, eventType: 'SecretDelivered' as const })),
          ...consolidatedEvents.map(e => ({ ...e, eventType: 'ShieldConsolidated' as const }))
        ].sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) {
            return a.blockNumber - b.blockNumber;
          }
          // Use transactionIndex and index for ordering within block
          return (a.transactionIndex - b.transactionIndex) || (a.index - b.index);
        });

        // Process events sequentially
        for (const event of allEvents) {
          try {
            switch (event.eventType) {
              case 'Shielded':
                const shieldResult = await this.processShieldedSequential(event, shieldIndex);
                if (shieldResult.isOurs) {
                  if (shieldResult.shield) {
                    recoveredShields.push(shieldResult.shield);
                  }
                  shieldIndex++;
                }
                break;

              case 'SecretDelivered':
                const receivedResult = await this.processSecretDeliveredSequential(event, receivedIndex);
                if (receivedResult.isOurs) {
                  if (receivedResult.shield) {
                    recoveredShields.push(receivedResult.shield);
                  }
                  receivedIndex++;
                }
                break;

              case 'Unshielded':
                const unshieldResult = await this.processUnshieldedSequential(event, remainderIndex);
                if (unshieldResult.isOurs && unshieldResult.createdRemainder) {
                  if (unshieldResult.remainderShield) {
                    recoveredShields.push(unshieldResult.remainderShield);
                  }
                  remainderIndex++;
                }
                break;

              case 'ShieldConsolidated':
                const consolidateResult = await this.processConsolidatedSequential(event, consolidateIndex);
                if (consolidateResult.isOurs) {
                  if (consolidateResult.shield) {
                    recoveredShields.push(consolidateResult.shield);
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
        // Continue with next batch
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
   * Process Shielded event with deterministic HD index
   */
  private async processShieldedSequential(event: any, expectedIndex: number): Promise<{
    isOurs: boolean;
    shield?: Shield;
  }> {
    if (!this.hdManager) {
      return { isOurs: false };
    }

    try {
      // Generate expected commitment for shield/{expectedIndex}
      const expectedSecret = this.hdManager.deriveSecret('shield', expectedIndex);
      const expectedCommitment = CryptoService.generateCommitment(expectedSecret, this.wallet);
      const actualCommitment = event.args.commitment;

      if (expectedCommitment === actualCommitment) {
        // This is our shield operation!
        console.log(`✅ Found our shield operation: shield/${expectedIndex}`);
        
        // Check if we already have this shield
        const existingShield = await this.storage.getShield(this.chainId, this.wallet, actualCommitment);
        if (existingShield) {
          return { isOurs: true }; // Already saved
        }

        const shield: Shield = {
          secret: expectedSecret,
          commitment: actualCommitment,
          token: event.args.token,
          amount: event.args.amount.toString(),
          timestamp: Date.now(),
          derivationPath: `shield/${expectedIndex}`,
          hdIndex: expectedIndex,
          hdOperation: 'shield',
          txHash: event.transactionHash,
          blockNumber: event.blockNumber
        };

        await this.storage.saveShield(this.chainId, this.wallet, shield);
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
  private async processSecretDeliveredSequential(event: any, expectedIndex: number): Promise<{
    isOurs: boolean;
    shield?: Shield;
  }> {
    if (!this.keys) {
      return { isOurs: false };
    }

    try {
      const encryptedSecret = event.args.encryptedSecret;
      const decryptedSecret = await CryptoService.decryptSecret(encryptedSecret, this.keys.privateKey as HexString);
      
      if (decryptedSecret) {
        // This secret is for us!
        console.log(`✅ Found received transfer: received/${expectedIndex}`);
        
        const commitment = CryptoService.generateCommitment(decryptedSecret, this.wallet);
        
        // Check if we already have this shield
        const existingShield = await this.storage.getShield(this.chainId, this.wallet, commitment);
        if (existingShield) {
          return { isOurs: true }; // Already saved
        }

        // Get shield info from contract
        const shieldInfo = await this.contract.getShieldInfo(commitment);
        
        if (shieldInfo.exists && !shieldInfo.spent) {
          const shield: Shield = {
            secret: decryptedSecret,
            commitment: commitment,
            token: shieldInfo.token,
            amount: shieldInfo.amount.toString(),
            timestamp: Date.now(),
            derivationPath: `received/${expectedIndex}`,
            hdIndex: expectedIndex,
            hdOperation: 'received',
            txHash: event.transactionHash,
            blockNumber: event.blockNumber
          };

          await this.storage.saveShield(this.chainId, this.wallet, shield);
          return { isOurs: true, shield };
        }
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
  private async processUnshieldedSequential(event: any, expectedRemainderIndex: number): Promise<{
    isOurs: boolean;
    createdRemainder: boolean;
    remainderShield?: Shield;
  }> {
    if (!this.hdManager) {
      return { isOurs: false, createdRemainder: false };
    }

    try {
      const unshieldedCommitment = event.args.commitment;
      
      // Check if this unshield belongs to us by checking if we have this shield
      const ourShield = await this.storage.getShield(this.chainId, this.wallet, unshieldedCommitment);
      
      if (ourShield) {
        // This is our unshield operation
        console.log(`✅ Found our unshield operation for commitment: ${unshieldedCommitment}`);
        
        // Check if a remainder shield was created by generating expected remainder commitment
        const expectedRemainderSecret = this.hdManager.deriveSecret('remainder', expectedRemainderIndex);
        const expectedRemainderCommitment = CryptoService.generateCommitment(expectedRemainderSecret, this.wallet);
        
        // Check if this remainder commitment exists on blockchain
        const remainderInfo = await this.contract.getShieldInfo(expectedRemainderCommitment);
        
        if (remainderInfo.exists && !remainderInfo.spent) {
          // Remainder was created!
          console.log(`✅ Found remainder shield: remainder/${expectedRemainderIndex}`);
          
          // Check if we already have this remainder shield
          const existingRemainder = await this.storage.getShield(this.chainId, this.wallet, expectedRemainderCommitment);
          if (!existingRemainder) {
            const remainderShield: Shield = {
              secret: expectedRemainderSecret,
              commitment: expectedRemainderCommitment,
              token: remainderInfo.token,
              amount: remainderInfo.amount.toString(),
              timestamp: Date.now(),
              derivationPath: `remainder/${expectedRemainderIndex}`,
              hdIndex: expectedRemainderIndex,
              hdOperation: 'remainder',
              txHash: event.transactionHash,
              blockNumber: event.blockNumber
            };

            await this.storage.saveShield(this.chainId, this.wallet, remainderShield);
            return { isOurs: true, createdRemainder: true, remainderShield };
          }
          
          return { isOurs: true, createdRemainder: true };
        }
        
        return { isOurs: true, createdRemainder: false };
      }

      return { isOurs: false, createdRemainder: false };
      
    } catch (error) {
      console.warn(`Failed to process Unshielded event:`, error);
      return { isOurs: false, createdRemainder: false };
    }
  }

  /**
   * Process ShieldConsolidated event with deterministic HD index
   */
  private async processConsolidatedSequential(event: any, expectedIndex: number): Promise<{
    isOurs: boolean;
    shield?: Shield;
  }> {
    if (!this.hdManager) {
      return { isOurs: false };
    }

    try {
      const newCommitment = event.args.newCommitment;
      
      // Generate expected commitment for consolidate/{expectedIndex}
      const expectedSecret = this.hdManager.deriveSecret('consolidate', expectedIndex);
      const expectedCommitment = CryptoService.generateCommitment(expectedSecret, this.wallet);

      if (expectedCommitment === newCommitment) {
        // This is our consolidation!
        console.log(`✅ Found our consolidation: consolidate/${expectedIndex}`);
        
        // Check if we already have this shield
        const existingShield = await this.storage.getShield(this.chainId, this.wallet, newCommitment);
        if (existingShield) {
          return { isOurs: true }; // Already saved
        }

        // Get shield info from contract
        const shieldInfo = await this.contract.getShieldInfo(newCommitment);
        
        if (shieldInfo.exists && !shieldInfo.spent) {
          const shield: Shield = {
            secret: expectedSecret,
            commitment: newCommitment,
            token: shieldInfo.token,
            amount: shieldInfo.amount.toString(),
            timestamp: Date.now(),
            derivationPath: `consolidate/${expectedIndex}`,
            hdIndex: expectedIndex,
            hdOperation: 'consolidate',
            txHash: event.transactionHash,
            blockNumber: event.blockNumber
          };

          await this.storage.saveShield(this.chainId, this.wallet, shield);
          return { isOurs: true, shield };
        }
      }

      return { isOurs: false };
      
    } catch (error) {
      console.warn(`Failed to process ShieldConsolidated event:`, error);
      return { isOurs: false };
    }
  }

  /**
   * Start scanning blockchain events
   */
  async startScanning(): Promise<void> {
    if (this.isRunning) {
      throw new LaserGunError('Scanner is already running', ErrorCode.SCANNER_ERROR);
    }

    if (!this.wallet || !this.keys || !this.hdManager) {
      throw new LaserGunError('Scanner not initialized', ErrorCode.SCANNER_ERROR);
    }

    // First recover any missing shields from blockchain if enabled
    if (this.enableHDRecovery) {
      await this.recoverFromBlockchain();
    }

    this.isRunning = true;
    this.emitStateChange();

    try {
      this.scanningPromise = this.scanLoop();
      await this.scanningPromise;
    } catch (error) {
      this.isRunning = false;
      this.emitStateChange();
      throw error;
    }
  }

  /**
   * Stop scanning
   */
  async stopScanning(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.emitStateChange();

    if (this.scanningPromise) {
      await this.scanningPromise;
      this.scanningPromise = null;
    }
  }

  /**
   * Change wallet/network (stops current scanning)
   */
  async changeContext(wallet: string, keys: CryptoKeys): Promise<void> {
    await this.stopScanning();
    await this.initialize(wallet, keys);
  }

  /**
   * Set transaction callback
   */
  onTransaction(callback: TransactionCallback): void {
    this.transactionCallback = callback;
  }

  /**
   * Set error callback
   */
  onError(callback: ErrorCallback): void {
    this.errorCallback = callback;
  }

  /**
   * Set state change callback
   */
  onStateChange(callback: StateChangeCallback): void {
    this.stateChangeCallback = callback;
  }

  /**
   * Get current scanner state
   */
  getState(): ScannerState {
    const baseState = {
      isRunning: this.isRunning,
      currentBlock: this.currentBlock,
      lastScannedBlock: this.lastScannedBlock,
      chainId: this.chainId,
      wallet: this.wallet
    };
    
    // Only include eventCounts if it exists
    if (this.eventCounts) {
      return {
        ...baseState,
        eventCounts: this.eventCounts
      };
    }
    
    return baseState;
  }

  /**
   * Main scanning loop for ongoing event monitoring
   */
  private async scanLoop(): Promise<void> {
    try {
      let fromBlock = await this.getStartingBlock();

      while (this.isRunning) {
        const latestBlock = await this.provider.getBlockNumber();
        
        if (fromBlock <= latestBlock) {
          const toBlock = Math.min(fromBlock + this.batchSize - 1, latestBlock);
          this.currentBlock = toBlock;

          await this.scanBatch(fromBlock, toBlock);
          
          // Save progress
          await this.storage.saveLastScannedBlock(this.chainId, this.wallet, toBlock);
          this.lastScannedBlock = toBlock;
          
          fromBlock = toBlock + 1;
          
          this.emitStateChange();
        } else {
          // Wait for new blocks
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        // Small delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      this.handleError(new LaserGunError(
        `Scanning error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.SCANNER_ERROR,
        error
      ));
    } finally {
      this.isRunning = false;
      this.emitStateChange();
    }
  }

  /**
   * Get starting block for scanning
   */
  private async getStartingBlock(): Promise<number> {
    const lastScanned = await this.storage.getLastScannedBlock(this.chainId, this.wallet);
    
    if (lastScanned !== null) {
      return lastScanned + 1;
    }
    
    return this.startBlock;
  }

  /**
   * Scan batch of blocks for new events (for ongoing monitoring)
   */
  private async scanBatch(fromBlock: number, toBlock: number): Promise<void> {
    try {
      // For ongoing scanning, we primarily monitor SecretDelivered events
      // Other events are handled by the main LaserGun class when operations are performed
      
      const secretEvents = await this.contract.queryFilter(
        this.contract.filters.SecretDelivered(),
        fromBlock,
        toBlock
      );

      for (const event of secretEvents) {
        await this.processIncomingSecretDelivered(event);
      }

    } catch (error) {
      throw new LaserGunError(
        `Failed to scan batch ${fromBlock}-${toBlock}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.SCANNER_ERROR,
        error
      );
    }
  }

  /**
   * Process incoming SecretDelivered event during ongoing scanning
   */
  private async processIncomingSecretDelivered(event: any): Promise<void> {
    if (!this.keys || !this.hdManager) return;

    try {
      const encryptedSecret = event.args.encryptedSecret;
      const secret = await CryptoService.decryptSecret(encryptedSecret, this.keys.privateKey as HexString);
      
      if (secret) {
        // This secret is for us! 
        const commitment = CryptoService.generateCommitment(secret, this.wallet);
        
        // Check if we already processed this
        const existingShield = await this.storage.getShield(this.chainId, this.wallet, commitment);
        if (existingShield) {
          return;
        }
        
        // Get shield info from contract
        const shieldInfo = await this.contract.getShieldInfo(commitment);
        
        if (shieldInfo.exists && !shieldInfo.spent) {
          // Update received count
          const currentCounts = this.eventCounts || await this.storage.loadEventCounts(this.chainId, this.wallet) || createEventCounts({
            lastUpdatedBlock: event.blockNumber
          });
          
          const newReceivedIndex = currentCounts.received;
          
          // Create shield with HD metadata
          const shield: Shield = {
            secret,
            commitment,
            token: shieldInfo.token,
            amount: shieldInfo.amount.toString(),
            timestamp: Date.now(),
            derivationPath: `received/${newReceivedIndex}`,
            hdIndex: newReceivedIndex,
            hdOperation: 'received',
            txHash: event.transactionHash,
            blockNumber: event.blockNumber
          };

          await this.storage.saveShield(this.chainId, this.wallet, shield);
          
          // Update event counts
          const updatedCounts = createEventCounts({
            shield: currentCounts.shield,
            remainder: currentCounts.remainder,
            received: currentCounts.received + 1,
            consolidate: currentCounts.consolidate,
            lastUpdatedBlock: Math.max(event.blockNumber, currentCounts.lastUpdatedBlock)
          });
          
          await this.storage.saveEventCounts(this.chainId, this.wallet, updatedCounts);
          this.eventCounts = updatedCounts;
          
          // Create transaction record with HD-based nonce
          const block = await this.provider.getBlock(event.blockNumber);
          const timestamp = block ? block.timestamp * 1000 : Date.now();
          
          const transaction: Transaction = {
            nonce: newReceivedIndex, // ✅ HD индекс как nonce
            type: 'received',
            txHash: event.transactionHash,
            blockNumber: event.blockNumber,
            timestamp: timestamp,
            token: shieldInfo.token,
            amount: shieldInfo.amount.toString(),
            commitment: commitment,
            derivationPath: `received/${newReceivedIndex}`,
            hdIndex: newReceivedIndex,
            hdOperation: 'received'
          };

          await this.storage.saveTransaction(this.chainId, this.wallet, transaction.nonce, transaction);
          
          if (this.transactionCallback) {
            this.transactionCallback(transaction);
          }
          
          console.log(`✅ Processed incoming transfer: received/${newReceivedIndex}`);
        }
      }
    } catch (error) {
      this.handleError(new LaserGunError(
        `Failed to process incoming SecretDelivered event: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.SCANNER_ERROR,
        error
      ));
    }
  }

  /**
   * Handle error and notify callback
   */
  private handleError(error: LaserGunError): void {
    if (this.errorCallback) {
      this.errorCallback(error);
    }
  }

  /**
   * Emit state change notification
   */
  private emitStateChange(): void {
    if (this.stateChangeCallback) {
      this.stateChangeCallback(this.getState());
    }
  }
}