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
} from '../types';
import { LaserGunError, ErrorCode } from '../types';
import { CryptoService, HDSecretManager } from '../crypto';
import { EventScanner } from './scanner';
import { LaserGunConfigManager } from './config';
import { RecoveryManager } from './recoveryManager';
import { ShieldOperations } from '../operations/shieldOperations';
import { TransferOperations } from '../operations/transferOperations';
import { TokenManager } from '../operations/tokenOperations';

/**
 * Main LaserGun SDK class with modular architecture
 * 
 * MODULAR DESIGN:
 * - LaserGunConfigManager: Configuration and network management
 * - TokenManager: ERC20 token operations and balance management
 * - ShieldOperations: Shield/Unshield/Consolidate operations
 * - TransferOperations: Private transfer operations
 * - RecoveryManager: Blockchain recovery and data validation
 * - EventScanner: Event monitoring and HD recovery
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
    
    // Initialize configuration manager
    this.configManager = new LaserGunConfigManager(config);
    
    // Initialize token operations manager
    this.tokenManager = new TokenManager(this.configManager, storage);
    
    // Initialize shield operations manager
    this.shieldOperations = new ShieldOperations(this.configManager, storage, this.tokenManager);
    
    // Initialize transfer operations manager
    this.transferOperations = new TransferOperations(this.configManager, storage, this.tokenManager);
    
    // Initialize event scanner
    this.scanner = new EventScanner(
      config.contractAddress,
      config.provider,
      storage,
      config.chainId,
      scannerConfig
    );
    
    // Initialize recovery manager (depends on scanner)
    this.recoveryManager = new RecoveryManager(this.configManager, storage, this.scanner);
  }

  /**
   * Initialize LaserGun for specific wallet with HD system
   */
  async initialize(): Promise<void> {
    try {
      // Initialize wallet and keys through config manager
      const { wallet, keys } = await this.configManager.initializeWallet();
      this.wallet = wallet;
      this.keys = keys;

      // Load or generate HD keys if needed
      const savedKeys = await this.storage.loadKeys(this.configManager.getConfig().chainId, this.wallet);
      if (savedKeys) {
        this.keys = savedKeys;
        this.configManager.setKeys(savedKeys);
      } else {
        await this.storage.saveKeys(this.configManager.getConfig().chainId, this.wallet, this.keys);
      }

      // Initialize HD manager
      this.hdManager = CryptoService.createHDManager(
        this.keys.privateKey as HexString,
        this.wallet,
        this.configManager.getConfig().chainId
      );

      // Load event counts
      this.eventCounts = await this.storage.loadEventCounts(
        this.configManager.getConfig().chainId, 
        this.wallet
      );

      // Ensure public key is registered
      await this.configManager.ensurePublicKeyRegistered();

      // Initialize all operation modules with HD manager and event counts
      this.initializeOperationModules();

      // Initialize scanner
      await this.scanner.initialize(this.wallet, this.keys);

    } catch (error) {
      throw new LaserGunError(
        `Failed to initialize LaserGun: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.INVALID_CONFIG,
        error
      );
    }
  }

  /**
   * Initialize operation modules with HD manager and event counts
   */
  private initializeOperationModules(): void {
    if (!this.hdManager || !this.eventCounts) {
      // Create default event counts if not loaded
      if (!this.eventCounts) {
        this.eventCounts = {
          shield: 0,
          remainder: 0,
          received: 0,
          consolidate: 0,
          lastUpdatedBlock: 0
        };
      }
    }

    // Set HD manager and event counts in operation modules
    this.shieldOperations.setHDManager(this.hdManager!);
    this.shieldOperations.setEventCounts(this.eventCounts!);
    
    this.transferOperations.setHDManager(this.hdManager!);
    this.transferOperations.setEventCounts(this.eventCounts!);
  }

  // ====================
  // SHIELD OPERATIONS (Delegated to ShieldOperations module)
  // ====================

  /**
   * Shield (privatize) ERC20 tokens with HD derivation
   */
  async shield(amount: string, tokenAddress: string): Promise<ShieldResult> {
    this.ensureInitialized();
    return await this.shieldOperations.shield(amount, tokenAddress);
  }

  /**
   * Unshield (convert back to public) tokens with HD remainder handling
   */
  async unshield(
    secret: HexString, 
    amount: string, 
    recipient: string
  ): Promise<UnshieldResult> {
    this.ensureInitialized();
    return await this.shieldOperations.unshield(secret, amount, recipient);
  }

  /**
   * Consolidate multiple shields into one with HD derivation
   */
  async consolidate(secrets: HexString[], tokenAddress: string): Promise<TransferResult> {
    this.ensureInitialized();
    return await this.shieldOperations.consolidate(secrets, tokenAddress);
  }

  // ====================
  // TRANSFER OPERATIONS (Delegated to TransferOperations module)
  // ====================

  /**
   * Transfer tokens privately to another user
   */
  async transfer(
    secret: HexString,
    amount: string,
    recipientCommitment: HexString,
    encryptedSecret: string
  ): Promise<TransferResult> {
    this.ensureInitialized();
    return await this.transferOperations.transfer(
      secret, 
      amount, 
      recipientCommitment, 
      encryptedSecret
    );
  }

  // ====================
  // TOKEN OPERATIONS (Delegated to TokenManager module)
  // ====================

  /**
   * Get token balance (both public and private) with blockchain verification
   */
  async getTokenBalance(tokenAddress: string): Promise<TokenBalance> {
    this.ensureInitialized();
    return await this.tokenManager.getTokenBalance(tokenAddress);
  }

  /**
   * Get detailed token information
   */
  async getTokenInfo(tokenAddress: string): Promise<{
    address: string;
    name: string;
    symbol: string;
    decimals: number;
  }> {
    this.ensureInitialized();
    return await this.tokenManager.getTokenInfo(tokenAddress);
  }

  /**
   * Check if address is a valid ERC20 token
   */
  async isValidToken(tokenAddress: string): Promise<boolean> {
    this.ensureInitialized();
    return await this.tokenManager.isValidToken(tokenAddress);
  }

  /**
   * Get user's public token allowance for LaserGun contract
   */
  async getAllowance(tokenAddress: string): Promise<string> {
    this.ensureInitialized();
    return await this.tokenManager.getAllowance(tokenAddress);
  }

  // ====================
  // RECOVERY OPERATIONS (Delegated to RecoveryManager module)
  // ====================

  /**
   * Recover all data from blockchain using HD scanner
   */
  async recoverFromBlockchain(): Promise<{
    shieldsRecovered: number;
    transactionsRecovered: number;
  }> {
    this.ensureInitialized();
    return await this.recoveryManager.recoverFromBlockchain();
  }

  /**
   * Emergency recovery with validation
   */
  async emergencyRecovery(fromBlock: number = 0): Promise<{
    shieldsRecovered: number;
    transactionsRecovered: number;
    errors: string[];
  }> {
    this.ensureInitialized();
    return await this.recoveryManager.emergencyRecovery(fromBlock);
  }

  /**
   * Validate data integrity
   */
  async validateDataIntegrity(): Promise<{
    isValid: boolean;
    issues: string[];
    suggestions: string[];
  }> {
    this.ensureInitialized();
    return await this.recoveryManager.validateDataIntegrity();
  }

  /**
   * Sync local storage with blockchain
   */
  async syncWithBlockchain(): Promise<{
    added: number;
    removed: number;
    updated: number;
  }> {
    this.ensureInitialized();
    return await this.recoveryManager.syncWithBlockchain();
  }

  /**
   * Get comprehensive recovery statistics
   */
  async getRecoveryStats(): Promise<{
    totalShields: number;
    activeShields: number;
    totalTransactions: number;
    transactionsByType: Record<string, number>;
    lastScannedBlock: number | null;
    eventCounts: EventCounts | null;
  }> {
    this.ensureInitialized();
    return await this.recoveryManager.getRecoveryStats();
  }

  // ====================
  // SCANNER OPERATIONS (Direct delegation to EventScanner)
  // ====================

  /**
   * Start event scanner
   */
  async startScanner(autoRecover: boolean = false): Promise<void> {
    this.ensureInitialized();

    if (autoRecover) {
      await this.recoverFromBlockchain();
    }

    await this.scanner.startScanning();
  }

  /**
   * Stop event scanner
   */
  async stopScanner(): Promise<void> {
    await this.scanner.stopScanning();
  }

  /**
   * Get scanner state
   */
  getScannerState(): ScannerState {
    return this.scanner.getState();
  }

  /**
   * Set scanner callbacks
   */
  onTransaction(callback: TransactionCallback): void {
    this.scanner.onTransaction(callback);
  }

  onError(callback: ErrorCallback): void {
    this.scanner.onError(callback);
  }

  onStateChange(callback: StateChangeCallback): void {
    this.scanner.onStateChange(callback);
  }

  // ====================
  // DATA ACCESS METHODS (Direct storage access)
  // ====================

  /**
   * Get transaction history
   */
  async getTransactionHistory(): Promise<Transaction[]> {
    this.ensureInitialized();

    try {
      return await this.storage.loadTransactions(
        this.configManager.getConfig().chainId, 
        this.wallet
      );
    } catch (error) {
      throw new LaserGunError(
        `Failed to load transaction history: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }

  /**
   * Get all user shields
   */
  async getUserShields(): Promise<Shield[]> {
    this.ensureInitialized();

    try {
      return await this.storage.loadShields(
        this.configManager.getConfig().chainId, 
        this.wallet
      );
    } catch (error) {
      throw new LaserGunError(
        `Failed to load user shields: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.STORAGE_ERROR,
        error
      );
    }
  }

  /**
   * Get current event counts
   */
  async getEventCounts(): Promise<EventCounts> {
    this.ensureInitialized();
    
    if (this.eventCounts) {
      return this.eventCounts;
    }
    
    // Load from storage if not in memory
    const counts = await this.storage.loadEventCounts(
      this.configManager.getConfig().chainId, 
      this.wallet
    );
    
    if (!counts) {
      throw new LaserGunError('Event counts not found. Run recoverFromBlockchain() first.', ErrorCode.STORAGE_ERROR);
    }
    
    this.eventCounts = counts;
    return counts;
  }

  // ====================
  // UTILITY METHODS (Getters and helpers)
  // ====================

  /**
   * Get current wallet address
   */
  getWallet(): string {
    return this.wallet;
  }

  /**
   * Get current public key
   */
  getPublicKey(): string | null {
    return this.keys?.publicKey || null;
  }

  /**
   * Get scanner instance for advanced operations
   */
  getScanner(): EventScanner {
    return this.scanner;
  }

  /**
   * Get configuration manager for advanced access
   */
  getConfigManager(): LaserGunConfigManager {
    return this.configManager;
  }

  /**
   * Get token manager for advanced token operations
   */
  getTokenManager(): TokenManager {
    return this.tokenManager;
  }

  /**
   * Get recovery manager for advanced recovery operations
   */
  getRecoveryManager(): RecoveryManager {
    return this.recoveryManager;
  }

  // ====================
  // PRIVATE HELPER METHODS
  // ====================

  private ensureInitialized(): void {
    if (!this.wallet || !this.keys || !this.hdManager) {
      throw new LaserGunError(
        'LaserGun not initialized. Call initialize() first.', 
        ErrorCode.INVALID_CONFIG
      );
    }
  }
}