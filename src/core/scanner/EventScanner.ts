import type { Provider } from 'ethers';
import { Contract } from 'ethers';
import type {
  IStorageAdapter,
  ScannerConfig,
  ScannerState,
  TransactionCallback,
  ErrorCallback,
  StateChangeCallback,
  ScannedBlockCallback,
  CryptoKeys,
  HexString,
  EventCounts
} from '../../types';
import { LaserGunError, ErrorCode } from '../../types';
import { CryptoService, HDSecretManager } from '../../crypto';
import { ErrorHelpers, StorageHelpers } from '../../utils';
import { HDRecovery } from './HDRecovery';
import { EventProcessor } from './EventProcessor';

/**
 * Refactored Event scanner for LaserGun contract
 * Main coordinator for HD recovery and ongoing event monitoring
 */
export class EventScanner {
  private readonly contract: Contract;
  private readonly provider: Provider;
  private readonly storage: IStorageAdapter;
  private readonly chainId: number;
  private readonly batchSize: number;
  private readonly startBlock: number;
  private readonly enableHDRecovery: boolean;

  // Sub-modules
  private readonly hdRecovery: HDRecovery;
  private readonly eventProcessor: EventProcessor;

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
  private blockScannedCallback?: ScannedBlockCallback;
  private recoveryBlockScannedCallback?: ScannedBlockCallback|undefined;

  // LaserGun contract ABI (only events we need)
  private static readonly CONTRACT_ABI = [
    'event Shielded(bytes32 indexed commitment, address indexed token, uint256 amount, uint256 fee)',
    'event Unshielded(bytes32 indexed commitment, address indexed token, uint256 amount, uint256 fee)',
    'event SecretDelivered(bytes encryptedSecret)',
    'event ShieldConsolidated(bytes32[] indexed oldCommitments, bytes32 indexed newCommitment)',
    'function getShieldInfo(bytes32 commitment) external view returns (bool exists, address token, uint256 amount, uint256 timestamp, bool spent)'
  ];

  constructor(
    contractAddress: string,
    provider: Provider,
    storage: IStorageAdapter,
    chainId: number,
    config: ScannerConfig = {},
    recoveryBlockScanned?: ScannedBlockCallback
  ) {
    this.contract = new Contract(contractAddress, EventScanner.CONTRACT_ABI, provider);
    this.provider = provider;
    this.storage = storage;
    this.chainId = chainId;
    this.batchSize = config.batchSize || 1000;
    this.startBlock = config.startBlock || 0;
    this.enableHDRecovery = config.enableHDRecovery ?? true;
    this.recoveryBlockScannedCallback = recoveryBlockScanned;

    // Initialize sub-modules
    this.hdRecovery = new HDRecovery(storage, chainId, this.batchSize);
    this.eventProcessor = new EventProcessor(storage, chainId);
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

      this.lastScannedBlock = await StorageHelpers.getLastScannedBlockSafely(
        this.storage, this.chainId, this.wallet
      );

      this.eventCounts = await StorageHelpers.loadEventCountsSafely(
        this.storage, this.chainId, this.wallet
      );

      this.emitStateChange();
    } catch (error) {
      throw ErrorHelpers.createError(
        error,
        'Failed to initialize scanner',
        ErrorCode.SCANNER_ERROR
      );
    }
  }

  /**
   * Perform sequential HD recovery from blockchain
   */
  async recoverFromBlockchain(): Promise<void> {
    if (!this.wallet || !this.keys || !this.hdManager) {
      throw new LaserGunError('Scanner not initialized', ErrorCode.SCANNER_ERROR);
    }

    try {
      console.log('🔍 Starting sequential HD recovery...');

      const { eventCounts, recoveredShields } = await this.hdRecovery.sequentialScan(
        this.contract,
        this.provider,
        this.hdManager,
        this.wallet,
        { privateKey: this.keys.privateKey as HexString },
        this.startBlock,
        this.recoveryBlockScannedCallback
      );

      console.log('📊 Final event counts:', eventCounts);
      console.log(`✅ Recovered ${recoveredShields.length} shields`);

      await StorageHelpers.saveEventCountsSafely(
        this.storage, this.chainId, this.wallet, eventCounts
      );
      this.eventCounts = eventCounts;

      this.emitStateChange();

    } catch (error) {
      throw ErrorHelpers.createError(
        error,
        'Failed to recover from blockchain',
        ErrorCode.SCANNER_ERROR
      );
    }
  }

  recoveryBlockScanned(blockId: number): void {
    this.lastScannedBlock = blockId;
    if (this.blockScannedCallback) this.blockScannedCallback(blockId)
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
    if (!this.isRunning) return;

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
   * Set callbacks
   */
  onTransaction(callback: TransactionCallback): void {
    this.transactionCallback = callback;
  }

  onError(callback: ErrorCallback): void {
    this.errorCallback = callback;
  }

  onBlockScanned(callback: ScannedBlockCallback): void {
    this.blockScannedCallback = callback;
  }

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

    if (this.eventCounts) {
      return { ...baseState, eventCounts: this.eventCounts };
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

          await this.eventProcessor.scanBatch(
            fromBlock,
            toBlock,
            this.contract,
            this.wallet,
            { privateKey: this.keys!.privateKey as HexString },
            this.transactionCallback,
            this.blockScannedCallback
          );

          // Save progress
          await StorageHelpers.saveLastScannedBlockSafely(
            this.storage, this.chainId, this.wallet, toBlock
          );
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
      this.handleError(ErrorHelpers.createError(
        error,
        'Scanning error',
        ErrorCode.SCANNER_ERROR
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
    const lastScanned = await StorageHelpers.getLastScannedBlockSafely(
      this.storage, this.chainId, this.wallet
    );

    return lastScanned > 0 ? lastScanned + 1 : this.startBlock;
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