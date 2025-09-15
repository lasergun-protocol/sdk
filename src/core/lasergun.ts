import type { 
  LaserGunConfig, 
  IStorageAdapter, 
  TokenBalance, 
  Shield, 
  Transaction,
  TransactionCallback,
  ErrorCallback,
  StateChangeCallback,
  ScannerConfig,
  ScannerState,
  ShieldResult,
  UnshieldResult,
  TransferResult,
  CryptoKeys,
  HexString,
  EventCounts,
  ScannedBlockCallback,
  HDOperation,
} from '../types';
import { CryptoService, HDSecretManager } from '../crypto';
import { EventScanner } from './scanner';
import { LaserGunConfigManager } from './config';
import { RecoveryManager } from './recoveryManager';
import { ShieldOperations } from '../operations/shieldOperations';
import { TransferOperations } from '../operations/transferOperations';
import { TokenManager } from '../operations/tokenOperations';
import { ErrorHelpers, StorageHelpers } from '../utils';

/**
 * Main LaserGun SDK class (REFACTORED)
 * Modular architecture with utility-based error handling
 */
export default class LaserGun {
  private readonly storage: IStorageAdapter;
  private readonly configManager: LaserGunConfigManager;
  private readonly tokenManager: TokenManager;
  private readonly shieldOperations: ShieldOperations;
  private readonly transferOperations: TransferOperations;
  private readonly recoveryManager: RecoveryManager;
  private readonly scanner: EventScanner;
 
  
  private keys: CryptoKeys | null = null;
  private hdManager: HDSecretManager | null = null;
  private wallet: string = '';
  private eventCounts: EventCounts | null = null;

  constructor(config: LaserGunConfig, storage: IStorageAdapter, scannerConfig?: ScannerConfig) {
    this.storage = storage;
    this.configManager = new LaserGunConfigManager(config);
    this.tokenManager = new TokenManager(this.configManager, storage);
    this.shieldOperations = new ShieldOperations(this.configManager, storage, this.tokenManager);
    this.transferOperations = new TransferOperations(this.configManager, storage);
    
    this.scanner = new EventScanner(
      config.contractAddress, config.provider, storage, config.chainId, scannerConfig);
    this.recoveryManager = new RecoveryManager(this.configManager, storage, this.scanner);
  }

  /**
   * Initialize LaserGun for specific wallet with HD system
   */
  async initialize(): Promise<void> {
    try {
      const { wallet, keys } = await this.configManager.initializeWallet();
      this.wallet = wallet;
      this.keys = keys;

      // Load or save keys
      const savedKeys = await this.storage.loadKeys(this.configManager.getConfig().chainId, this.wallet);
      if (savedKeys) {
        this.keys = savedKeys;
        this.configManager.setKeys(savedKeys);
      } else {
        await this.storage.saveKeys(this.configManager.getConfig().chainId, this.wallet, this.keys);
      }

      // Initialize HD manager and event counts
      this.hdManager = CryptoService.createHDManager(
        this.keys.privateKey as HexString, this.wallet, this.configManager.getConfig().chainId
      );
      
      this.eventCounts = await StorageHelpers.loadEventCounts(
        this.storage, this.configManager.getConfig().chainId, this.wallet
      );

      await this.configManager.ensurePublicKeyRegistered();
      this.initializeOperationModules();
      await this.scanner.initialize(this.wallet, this.keys);

    } catch (error) {
      throw ErrorHelpers.initializationError('LaserGun', ErrorHelpers.getErrorMessage(error));
    }
  }

  // ====================
  // SHIELD OPERATIONS (Delegated)
  // ====================

  async shield(amount: bigint, tokenAddress: string): Promise<ShieldResult> {
    this.ensureInitialized();
    return await this.shieldOperations.shield(amount, tokenAddress);
  }

  async unshield(secret: HexString, amount: bigint, recipient: string): Promise<UnshieldResult> {
    this.ensureInitialized();
    return await this.shieldOperations.unshield(secret, amount, recipient);
  }

  async consolidate(secrets: HexString[], tokenAddress: string): Promise<TransferResult> {
    this.ensureInitialized();
    return await this.shieldOperations.consolidate(secrets, tokenAddress);
  }

  // ====================
  // TRANSFER OPERATIONS (Delegated)
  // ====================

  async transfer(
    secret: HexString, amount: bigint, recipientCommitment: HexString, encryptedSecret: string
  ): Promise<TransferResult> {
    this.ensureInitialized();
    return await this.transferOperations.transfer(secret, amount, recipientCommitment, encryptedSecret);
  }

  // ====================
  // TOKEN OPERATIONS (Delegated)
  // ====================

  async getTokenBalance(tokenAddress: string): Promise<TokenBalance> {
    this.ensureInitialized();
    return await this.tokenManager.getTokenBalance(tokenAddress);
  }

  async getTokenInfo(tokenAddress: string): Promise<{
    address: string; name: string; symbol: string; decimals: number;
  }> {
    this.ensureInitialized();
    return await this.tokenManager.getTokenInfo(tokenAddress);
  }

  async isValidToken(tokenAddress: string): Promise<boolean> {
    this.ensureInitialized();
    return await this.tokenManager.isValidToken(tokenAddress);
  }

  async getAllowance(tokenAddress: string): Promise<bigint> {
    this.ensureInitialized();
    return await this.tokenManager.getAllowance(tokenAddress);
  }

  // ====================
  // RECOVERY OPERATIONS (Delegated)
  // ====================

  async recoverFromBlockchain(): Promise<{ shieldsRecovered: number; transactionsRecovered: number; }> {
    this.ensureInitialized();
    return await this.recoveryManager.recoverFromBlockchain();
  }
 

  async validateDataIntegrity(): Promise<{
    isValid: boolean; issues: string[]; suggestions: string[];
  }> {
    this.ensureInitialized();
    return await this.recoveryManager.validateDataIntegrity();
  }

  async syncWithBlockchain(): Promise<{ added: number; removed: number; updated: number; }> {
    this.ensureInitialized();
    return await this.recoveryManager.syncWithBlockchain();
  }

  async getRecoveryStats(): Promise<{
    totalShields: number; activeShields: number; totalTransactions: number;
    transactionsByType: Record<string, number>; lastScannedBlock: number | null; eventCounts: EventCounts | null;
  }> {
    this.ensureInitialized();
    return await this.recoveryManager.getRecoveryStats();
  }

  // ====================
  // SCANNER OPERATIONS (Delegated)
  // ====================

  async startScanner(autoRecover: boolean = false): Promise<void> {
    this.ensureInitialized();
    if (autoRecover) await this.recoverFromBlockchain();
    await this.scanner.startScanning();
  }

  async stopScanner(): Promise<void> {
    await this.scanner.stopScanning();
  }

  getScannerState(): ScannerState {
    return this.scanner.getState();
  }

  onTransaction(callback: TransactionCallback): void {
    this.scanner.onTransaction(callback);
  }

  onError(callback: ErrorCallback): void {
    this.scanner.onError(callback);
  }

  onBlockScanned(callback: ScannedBlockCallback): void {
    this.scanner.onBlockScanned(callback);
  }

  onStateChange(callback: StateChangeCallback): void {
    this.scanner.onStateChange(callback);
  }

  // ====================
  // DATA ACCESS METHODS (With error handling)
  // ====================

  async getTransactionHistory(): Promise<Transaction[]> {
    this.ensureInitialized();
    return await StorageHelpers.loadTransactions(
      this.storage, this.configManager.getConfig().chainId, this.wallet
    );
  }

  

  async getUserShields(): Promise<Shield[]> {
    this.ensureInitialized();
    return await StorageHelpers.loadShields(
      this.storage, this.configManager.getConfig().chainId, this.wallet
    );
  }

  /**
 * Get shields for specific token address
 */
async getTokenShields(tokenAddress: string): Promise<Shield[]> {
  this.ensureInitialized();
  
  // Validate token address
  if (!CryptoService.isValidAddress(tokenAddress)) {
    throw ErrorHelpers.validationError('tokenAddress', tokenAddress, 'valid Ethereum address');
  }
  
  // Get all shields and filter by token (reuse existing method)
  const allShields = await this.getUserShields();
  
  // Filter shields by token address (case insensitive)
  return allShields.filter(shield => 
    shield.token.toLowerCase() === tokenAddress.toLowerCase()
  );
}

  async getEventCounts(): Promise<EventCounts> {
    this.ensureInitialized();
    
    if (this.eventCounts) return this.eventCounts;
    
    const counts = await StorageHelpers.loadEventCounts(
      this.storage, this.configManager.getConfig().chainId, this.wallet
    );
    
    if (!counts) {
      throw ErrorHelpers.storageError('get event counts', 'Event counts not found. Run recoverFromBlockchain() first.');
    }
    
    this.eventCounts = counts;
    return counts;
  }

  // ====================
  // UTILITY METHODS (Getters)
  // ====================

  getWallet(): string { return this.wallet; }
  getPublicKey(): string | null { return this.keys?.publicKey || null; }
  getScanner(): EventScanner { return this.scanner; }
  getConfigManager(): LaserGunConfigManager { return this.configManager; }
  getTokenManager(): TokenManager { return this.tokenManager; }
  getRecoveryManager(): RecoveryManager { return this.recoveryManager; }

/**
 * Generate HD secret for specific operation and index
 * Requires initialization before use
 */
deriveSecret(operation: HDOperation, index: number): HexString {
  this.ensureInitialized();
  return this.hdManager!.deriveSecret(operation, index);
}

  // ====================
  // PRIVATE HELPERS
  // ====================

  private initializeOperationModules(): void {
    if (!this.eventCounts) {
      this.eventCounts = {
        shield: 0, remainder: 0, received: 0, consolidate: 0, lastUpdatedBlock: 0, unshield:0, transfer:0
      };
    }

    this.shieldOperations.setHDManager(this.hdManager!);
    this.shieldOperations.setEventCounts(this.eventCounts!);
    this.transferOperations.setHDManager(this.hdManager!);
    this.transferOperations.setEventCounts(this.eventCounts!);
  }

  private ensureInitialized(): void {
    if (!this.wallet || !this.keys || !this.hdManager) {
      throw ErrorHelpers.initializationError('LaserGun', 'Call initialize() first');
    }
  }
}