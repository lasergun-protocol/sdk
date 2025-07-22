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
  Shield
} from '../types';
import { LaserGunError, ErrorCode } from '../types';
import { CryptoService } from '../crypto';
import { EventLog } from 'ethers';

/**
 * Event scanner for LaserGun contract
 * Automatically scans blockchain events and processes incoming transactions
 * FIXED: Now recovers our own shields from blockchain
 */
export class EventScanner {
  private readonly contract: Contract;
  private readonly provider: Provider;
  private readonly storage: IStorageAdapter;
  private readonly chainId: number;
  private readonly batchSize: number;
  private readonly startBlock: number;

  private wallet: string = '';
  private keys: CryptoKeys | null = null;
  private isRunning: boolean = false;
  private currentNonce: number = 0;
  private currentBlock: number = 0;
  private lastScannedBlock: number = 0;
  private scanningPromise: Promise<void> | null = null;
  private noncePromise: Promise<number> | null = null;

  // Cache for our secrets to avoid regenerating
  private ourSecretsCache: Map<string, {secret: HexString, nonce: number}> = new Map();
  private maxNonceToCheck: number = 1000; // Reasonable limit for nonce checking

  // Callbacks
  private transactionCallback?: TransactionCallback;
  private errorCallback?: ErrorCallback;
  private stateChangeCallback?: StateChangeCallback;

  // LaserGun contract ABI (only events we need)
  private static readonly CONTRACT_ABI = [
    'event Shielded(bytes32 indexed commitment, address indexed token, uint256 amount, uint256 fee)',
    'event Unshielded(bytes32 indexed commitment, address indexed token, uint256 amount, uint256 fee)',
    'event SecretDelivered(bytes encryptedSecret)',
    'event ShieldConsolidated(bytes32[] indexed oldCommitments, bytes32 indexed newCommitment)'
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
    this.batchSize = config.batchSize || 10000;
    this.startBlock = config.startBlock || 0;
  }

  /**
   * Initialize scanner for specific wallet
   */
  async initialize(wallet: string, keys: CryptoKeys): Promise<void> {
    try {
      this.wallet = wallet.toLowerCase();
      this.keys = keys;
      this.currentNonce = await this.storage.getLastNonce(this.chainId, this.wallet);
      this.lastScannedBlock = await this.storage.getLastScannedBlock(this.chainId, this.wallet) || 0;
      
      // Initialize secrets cache
      await this.initializeSecretsCache();
      
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
   * Initialize cache of our possible secrets
   */
  private async initializeSecretsCache(): Promise<void> {
    if (!this.keys) return;

    // Get current max nonce from storage
    const lastNonce = await this.storage.getLastNonce(this.chainId, this.wallet);
    const maxNonce = Math.min(lastNonce + 100, this.maxNonceToCheck); // Check a bit beyond current nonce

    // Generate all possible secrets for our wallet
    for (let nonce = 0; nonce <= maxNonce; nonce++) {
      const secret = CryptoService.generateSecret(this.keys.privateKey as HexString, nonce);
      const commitment = CryptoService.generateCommitment(secret, this.wallet);
      this.ourSecretsCache.set(commitment, { secret, nonce });
    }
  }

  /**
   * Check if commitment belongs to us and return secret
   */
  private async isOurCommitment(commitment: string): Promise<{isOurs: boolean, secret?: HexString, nonce?: number}> {
    // First check cache
    const cached = this.ourSecretsCache.get(commitment);
    if (cached) {
      return { isOurs: true, secret: cached.secret, nonce: cached.nonce };
    }

    // If not in cache, extend search range
    if (!this.keys) return { isOurs: false };

    const currentMaxNonce = Math.max(...Array.from(this.ourSecretsCache.values()).map(v => v.nonce));
    
    // Check additional range
    for (let nonce = currentMaxNonce + 1; nonce <= currentMaxNonce + 200; nonce++) {
      const secret = CryptoService.generateSecret(this.keys.privateKey as HexString, nonce);
      const testCommitment = CryptoService.generateCommitment(secret, this.wallet);
      
      // Add to cache
      this.ourSecretsCache.set(testCommitment, { secret, nonce });
      
      if (testCommitment === commitment) {
        return { isOurs: true, secret, nonce };
      }
    }

    return { isOurs: false };
  }

  /**
   * Recover all our shields from blockchain
   */
  async recoverFromBlockchain(): Promise<void> {
    if (!this.wallet || !this.keys) {
      throw new LaserGunError('Scanner not initialized', ErrorCode.SCANNER_ERROR);
    }

    try {
      const latestBlock = await this.provider.getBlockNumber();
      const fromBlock = this.startBlock;

      // Get all Shielded events
      const shieldedEvents = await this.contract.queryFilter(
        this.contract.filters.Shielded(),
        fromBlock,
        latestBlock
      );

      let recoveredCount = 0;

      for (const event of shieldedEvents) {
        const commitment = (event as EventLog).args.commitment;
        
        // Check if this is our commitment
        const ownershipCheck = await this.isOurCommitment(commitment);
        
        if (ownershipCheck.isOurs && ownershipCheck.secret && ownershipCheck.nonce !== undefined) {
          // Check if we already have this shield
          const existingShield = await this.storage.getShield(this.chainId, this.wallet, commitment);
          
          if (!existingShield) {
            // Create and save shield
            const shield: Shield = {
              secret: ownershipCheck.secret,
              commitment: commitment,
              token: (event as EventLog).args.token,
              amount: (event as EventLog).args.amount.toString(),
              timestamp: Date.now()
            };

            await this.storage.saveShield(this.chainId, this.wallet, shield);

            // Create transaction record
            const block = await this.provider.getBlock(event.blockNumber);
            const timestamp = block ? block.timestamp * 1000 : Date.now();

            const transaction: Transaction = {
              nonce: ownershipCheck.nonce,
              type: 'shield',
              txHash: event.transactionHash,
              blockNumber: event.blockNumber,
              timestamp: timestamp,
              token: (event as EventLog).args.token,
              amount: (event as EventLog).args.amount.toString(),
              commitment: commitment,
              fee: (event as EventLog).args.fee.toString()
            };

            await this.storage.saveTransaction(this.chainId, this.wallet, transaction.nonce, transaction);
            
            recoveredCount++;

            if (this.transactionCallback) {
              this.transactionCallback(transaction);
            }
          }
        }
      }

      console.log(`Recovered ${recoveredCount} shields from blockchain`);
    } catch (error) {
      throw new LaserGunError(
        `Failed to recover from blockchain: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.SCANNER_ERROR,
        error
      );
    }
  }

  /**
   * Start scanning blockchain events
   */
  async startScanning(): Promise<void> {
    if (this.isRunning) {
      throw new LaserGunError('Scanner is already running', ErrorCode.SCANNER_ERROR);
    }

    if (!this.wallet || !this.keys) {
      throw new LaserGunError('Scanner not initialized', ErrorCode.SCANNER_ERROR);
    }

    // First recover any missing shields from blockchain
    await this.recoverFromBlockchain();

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
    this.ourSecretsCache.clear();
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
    return {
      isRunning: this.isRunning,
      currentBlock: this.currentBlock,
      lastScannedBlock: this.lastScannedBlock,
      chainId: this.chainId,
      wallet: this.wallet
    };
  }

  /**
   * Main scanning loop
   */
  private async scanLoop(): Promise<void> {
    try {
      const latestBlock = await this.provider.getBlockNumber();
      let fromBlock = await this.getStartingBlock();

      while (this.isRunning && fromBlock <= latestBlock) {
        const toBlock = Math.min(fromBlock + this.batchSize - 1, latestBlock);
        this.currentBlock = toBlock;

        await this.scanBatch(fromBlock, toBlock);
        
        // Save progress
        await this.storage.saveLastScannedBlock(this.chainId, this.wallet, toBlock);
        this.lastScannedBlock = toBlock;
        
        fromBlock = toBlock + 1;
        
        this.emitStateChange();
        
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
   * Scan batch of blocks for events
   */
  private async scanBatch(fromBlock: number, toBlock: number): Promise<void> {
    try {
      // Scan for SecretDelivered events (incoming transfers)
      const secretEvents = await this.contract.queryFilter(
        this.contract.filters.SecretDelivered(),
        fromBlock,
        toBlock
      );

      for (const event of secretEvents) {
        await this.processSecretDeliveredEvent(event);
      }

      // Scan for our Shielded events (to track our shields)
      const shieldedEvents = await this.contract.queryFilter(
        this.contract.filters.Shielded(),
        fromBlock,
        toBlock
      );

      for (const event of shieldedEvents) {
        await this.processShieldedEvent(event);
      }

      // Scan for Unshielded events
      const unshieldedEvents = await this.contract.queryFilter(
        this.contract.filters.Unshielded(),
        fromBlock,
        toBlock
      );

      for (const event of unshieldedEvents) {
        await this.processUnshieldedEvent(event);
      }

      // Scan for Consolidated events
      const consolidatedEvents = await this.contract.queryFilter(
        this.contract.filters.ShieldConsolidated(),
        fromBlock,
        toBlock
      );

      for (const event of consolidatedEvents) {
        await this.processConsolidatedEvent(event);
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
   * Process SecretDelivered event (potential incoming transfer)
   */
  private async processSecretDeliveredEvent(event: any): Promise<void> {
    if (!this.keys) return;

    try {
      const encryptedSecret = event.args.encryptedSecret;
      const secret = await CryptoService.decryptSecret(encryptedSecret, this.keys.privateKey as HexString);
      
      if (secret) {
        // This secret is for us! Create received transaction
        const commitment = CryptoService.generateCommitment(secret, this.wallet);
        
        // Get shield info from contract to determine amount and token
        const shieldInfo = await this.contract.getShieldInfo(commitment);
        
        if (shieldInfo.exists && !shieldInfo.spent) {
          // Check for duplicate transactions to prevent reprocessing
          const existingTx = await this.checkForDuplicateTransaction(event.transactionHash, commitment);
          if (existingTx) {
            return; // Skip duplicate
          }
          
          // Get block timestamp
          const block = await this.provider.getBlock(event.blockNumber);
          const timestamp = block ? block.timestamp * 1000 : Date.now();
          
          // Get next nonce safely
          const nextNonce = await this.getNextNonce();
          
          const transaction: Transaction = {
            nonce: nextNonce,
            type: 'received',
            txHash: event.transactionHash,
            blockNumber: event.blockNumber,
            timestamp: timestamp,
            token: shieldInfo.token,
            amount: shieldInfo.amount.toString(),
            commitment: commitment
          };

          await this.saveTransaction(transaction);

          // Also save the shield
          const shield: Shield = {
            secret,
            commitment,
            token: shieldInfo.token,
            amount: shieldInfo.amount.toString(),
            timestamp: timestamp
          };

          await this.storage.saveShield(this.chainId, this.wallet, shield);
        }
      }
    } catch (error) {
      this.handleError(new LaserGunError(
        `Failed to process SecretDelivered event: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.SCANNER_ERROR,
        error
      ));
    }
  }

  /**
   * Process Shielded event (FIXED: now properly handles our own shields)
   */
  private async processShieldedEvent(event: any): Promise<void> {
    try {
      const commitment = event.args.commitment;
      const token = event.args.token;
      const amount = event.args.amount.toString();
      const fee = event.args.fee.toString();

      // Check for duplicate transactions first
      const existingTx = await this.checkForDuplicateTransaction(event.transactionHash, commitment);
      if (existingTx) {
        return; // Skip duplicate
      }

      // Check if this commitment belongs to us
      const ownershipCheck = await this.isOurCommitment(commitment);
      
      if (ownershipCheck.isOurs && ownershipCheck.secret && ownershipCheck.nonce !== undefined) {
        // This is OUR shield operation - create transaction record
        const block = await this.provider.getBlock(event.blockNumber);
        const timestamp = block ? block.timestamp * 1000 : Date.now();

        const transaction: Transaction = {
          nonce: ownershipCheck.nonce,
          type: 'shield',
          txHash: event.transactionHash,
          blockNumber: event.blockNumber,
          timestamp: timestamp,
          token: token,
          amount: amount,
          commitment: commitment,
          fee: fee
        };

        await this.saveTransaction(transaction);

        // Save the shield object too
        const shield: Shield = {
          secret: ownershipCheck.secret,
          commitment: commitment,
          token: token,
          amount: amount,
          timestamp: timestamp
        };

        await this.storage.saveShield(this.chainId, this.wallet, shield);
      }
      // If it's not our commitment, ignore (could be incoming transfer handled by SecretDelivered)
      
    } catch (error) {
      this.handleError(new LaserGunError(
        `Failed to process Shielded event: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.SCANNER_ERROR,
        error
      ));
    }
  }

  /**
   * Process Unshielded event (FIXED: now properly handles our operations)
   */
  private async processUnshieldedEvent(event: any): Promise<void> {
    try {
      const commitment = event.args.commitment;
      const token = event.args.token;
      const amount = event.args.amount.toString();
      const fee = event.args.fee.toString();

      // Check for duplicate transactions first
      const existingTx = await this.checkForDuplicateTransaction(event.transactionHash, commitment);
      if (existingTx) {
        return; // Skip duplicate
      }

      // Check if this commitment belongs to us
      const ownershipCheck = await this.isOurCommitment(commitment);
      
      if (ownershipCheck.isOurs && ownershipCheck.nonce !== undefined) {
        // This is OUR unshield operation - create transaction record
        const block = await this.provider.getBlock(event.blockNumber);
        const timestamp = block ? block.timestamp * 1000 : Date.now();

        const nextNonce = await this.getNextNonce();

        const transaction: Transaction = {
          nonce: nextNonce,
          type: 'unshield',
          txHash: event.transactionHash,
          blockNumber: event.blockNumber,
          timestamp: timestamp,
          token: token,
          amount: amount,
          commitment: commitment,
          fee: fee
        };

        await this.saveTransaction(transaction);
      }
      // If it's not our commitment, ignore
      
    } catch (error) {
      this.handleError(new LaserGunError(
        `Failed to process Unshielded event: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.SCANNER_ERROR,
        error
      ));
    }
  }

  /**
   * Process ShieldConsolidated event
   */
  private async processConsolidatedEvent(event: any): Promise<void> {
    try {
      const oldCommitments = event.args.oldCommitments;
      const newCommitment = event.args.newCommitment;

      // Check if this consolidation involves our commitments
      let isOurConsolidation = false;
      let totalAmount = 0n;
      let token = '';
      
      for (const oldCommitment of oldCommitments) {
        const ownershipCheck = await this.isOurCommitment(oldCommitment);
        
        if (ownershipCheck.isOurs) {
          isOurConsolidation = true;
          
          // Get shield info to calculate total
          const shieldInfo = await this.contract.getShieldInfo(oldCommitment);
          if (shieldInfo.exists) {
            totalAmount += BigInt(shieldInfo.amount.toString());
            token = shieldInfo.token;
          }
        }
      }
      
      if (isOurConsolidation && token) {
        // Check for duplicate
        const existingTx = await this.checkForDuplicateTransaction(event.transactionHash, newCommitment);
        if (existingTx) {
          return;
        }

        // Get block timestamp
        const block = await this.provider.getBlock(event.blockNumber);
        const timestamp = block ? block.timestamp * 1000 : Date.now();
        
        // Get next nonce safely
        const nextNonce = await this.getNextNonce();
        
        const transaction: Transaction = {
          nonce: nextNonce,
          type: 'transfer', // Consolidation is internal transfer
          txHash: event.transactionHash,
          blockNumber: event.blockNumber,
          timestamp: timestamp,
          token: token,
          amount: totalAmount.toString(),
          commitment: newCommitment
        };
        
        await this.saveTransaction(transaction);

        // Save the new consolidated shield if it's ours
        const newOwnershipCheck = await this.isOurCommitment(newCommitment);
        if (newOwnershipCheck.isOurs && newOwnershipCheck.secret) {
          const shield: Shield = {
            secret: newOwnershipCheck.secret,
            commitment: newCommitment,
            token: token,
            amount: totalAmount.toString(),
            timestamp: timestamp
          };

          await this.storage.saveShield(this.chainId, this.wallet, shield);
        }
      }
    } catch (error) {
      this.handleError(new LaserGunError(
        `Failed to process Consolidated event: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.SCANNER_ERROR,
        error
      ));
    }
  }

  /**
   * Save transaction and notify callback
   */
  private async saveTransaction(transaction: Transaction): Promise<void> {
    try {
      await this.storage.saveTransaction(this.chainId, this.wallet, transaction.nonce, transaction);
      this.currentNonce = Math.max(this.currentNonce, transaction.nonce);
      
      if (this.transactionCallback) {
        this.transactionCallback(transaction);
      }
    } catch (error) {
      this.handleError(new LaserGunError(
        `Failed to save transaction: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      ));
    }
  }

  /**
   * Check for duplicate transaction to prevent reprocessing
   */
  private async checkForDuplicateTransaction(txHash: string, commitment?: string): Promise<Transaction | null> {
    try {
      const transactions = await this.storage.loadTransactions(this.chainId, this.wallet);
      
      return transactions.find(tx => 
        tx.txHash === txHash && 
        (!commitment || tx.commitment === commitment)
      ) || null;
    } catch (error) {
      // If we can't check, assume no duplicate to avoid losing transactions
      return null;
    }
  }

  /**
   * Get next available nonce safely
   */
  private async getNextNonce(): Promise<number> {
    // Ensure thread-safe nonce generation
    if (this.noncePromise) {
      await this.noncePromise;
    }

    this.noncePromise = (async () => {
      const lastNonce = await this.storage.getLastNonce(this.chainId, this.wallet);
      this.currentNonce = Math.max(this.currentNonce, lastNonce) + 1;
      return this.currentNonce;
    })();

    const nonce = await this.noncePromise;
    this.noncePromise = null;
    return nonce;
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