import { Contract, parseUnits, ZeroHash } from 'ethers';
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
import { LaserGunError, ErrorCode, createEventCounts } from '../types';
import { CryptoService, HDSecretManager } from '../crypto';
import { EventScanner } from './scanner';

/**
 * Main LaserGun SDK class with HD derivation support
 * Provides privacy-preserving ERC20 operations with deterministic HD recovery
 */
export default class LaserGun {
  private readonly config: LaserGunConfig;
  private readonly contract: Contract;
  private readonly storage: IStorageAdapter;
  private readonly scanner: EventScanner;
  
  private keys: CryptoKeys | null = null;
  private hdManager: HDSecretManager | null = null;
  private wallet: string = '';
  private eventCounts: EventCounts | null = null;

  // LaserGun contract ABI
  private static readonly CONTRACT_ABI = [
    // View functions
    'function getShieldInfo(bytes32 commitment) external view returns (bool exists, address token, uint256 amount, uint256 timestamp, bool spent)',
    'function getShieldBalance(bytes32 secret, address token) external view returns (uint256)',
    'function generateCommitment(bytes32 secret, address recipient) external pure returns (bytes32)',
    'function isCommitmentActive(bytes32 commitment) external view returns (bool)',
    
    // Core functions
    'function shield(uint256 amount, address token, bytes32 commitment) external',
    'function unshield(bytes32 secret, uint256 redeemAmount, address recipient, bytes32 newCommitment) external',
    'function transfer(bytes32 secret, uint256 amount, bytes32 recipientCommitment, bytes calldata encryptedSecret) external',
    'function consolidate(bytes32[] calldata secrets, bytes32 newCommitment) external',
    
    // Public key management
    'function registerPublicKey(bytes calldata publicKey) external',
    'function publicKeys(address user) external view returns (bytes)',
    'function userNonces(address user) external view returns (uint256)',
    
    // Fee info
    'function shieldFeePercent() external view returns (uint256)',
    'function unshieldFeePercent() external view returns (uint256)',
    'function FEE_DENOMINATOR() external view returns (uint256)',
    
    // Events
    'event Shielded(bytes32 indexed commitment, address indexed token, uint256 amount, uint256 fee)',
    'event Unshielded(bytes32 indexed commitment, address indexed token, uint256 amount, uint256 fee)',
    'event SecretDelivered(bytes encryptedSecret)',
    'event ShieldConsolidated(bytes32[] indexed oldCommitments, bytes32 indexed newCommitment)'
  ];

  // Standard ERC20 ABI for token operations
  private static readonly ERC20_ABI = [
    'function balanceOf(address owner) external view returns (uint256)',
    'function allowance(address owner, address spender) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function symbol() external view returns (string)',
    'function decimals() external view returns (uint8)',
    'function name() external view returns (string)'
  ];

  constructor(config: LaserGunConfig, storage: IStorageAdapter, scannerConfig?: ScannerConfig) {
    this.validateConfig(config);
    
    this.config = config;
    this.storage = storage;
    this.contract = new Contract(config.contractAddress, LaserGun.CONTRACT_ABI, config.signer);
    
    this.scanner = new EventScanner(
      config.contractAddress,
      config.provider,
      storage,
      config.chainId,
      scannerConfig
    );
  }

  /**
   * Initialize LaserGun for specific wallet with HD system
   */
  async initialize(): Promise<void> {
    try {
      this.wallet = (await this.config.signer.getAddress()).toLowerCase();
      
      // Load or generate HD keys
      this.keys = await this.storage.loadKeys(this.config.chainId, this.wallet);
      
      if (!this.keys) {
        this.keys = await this.generateNewKeys();
        await this.storage.saveKeys(this.config.chainId, this.wallet, this.keys);
      }
      
      // Initialize HD manager
      this.hdManager = CryptoService.createHDManager(
        this.keys.privateKey as HexString,
        this.wallet,
        this.config.chainId
      );
      
      // Load event counts
      this.eventCounts = await this.storage.loadEventCounts(this.config.chainId, this.wallet);
      
      // Register public key if not already registered
      await this.ensurePublicKeyRegistered();
      
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
   * Shield (privatize) ERC20 tokens with HD derivation
   */
  async shield(amount: string, tokenAddress: string): Promise<ShieldResult> {
    this.ensureInitialized();
    
    try {
      // Validate inputs
      if (!CryptoService.isValidAddress(tokenAddress)) {
        throw new LaserGunError('Invalid token address', ErrorCode.VALIDATION_ERROR);
      }
      
      const parsedAmount = parseUnits(amount, await this.getTokenDecimals(tokenAddress));
      if (parsedAmount <= 0n) {
        throw new LaserGunError('Amount must be positive', ErrorCode.INVALID_AMOUNT);
      }
      
      // Check balance and allowance
      await this.checkTokenBalance(tokenAddress, parsedAmount);
      await this.ensureAllowance(tokenAddress, parsedAmount);
      
      // Get current shield index and generate HD secret
      const currentCounts = await this.getCurrentEventCounts();
      const shieldIndex = currentCounts.shield;
      const secret = this.hdManager!.deriveSecret('shield', shieldIndex);
      const commitment = CryptoService.generateCommitment(secret, this.wallet);
      
      // Execute shield transaction
      const tx = await this.contract.shield(parsedAmount, tokenAddress, commitment);
      const receipt = await tx.wait();
      
      // Calculate net amount after fees
      const feePercent = await this.contract.shieldFeePercent();
      const feeDenominator = await this.contract.FEE_DENOMINATOR();
      const fee = parsedAmount * feePercent / feeDenominator;
      const netAmount = parsedAmount - fee;
      
      // Store shield with HD metadata
      const shield: Shield = {
        secret,
        commitment,
        token: tokenAddress,
        amount: netAmount.toString(),
        timestamp: Date.now(),
        derivationPath: `shield/${shieldIndex}`,
        hdIndex: shieldIndex,
        hdOperation: 'shield',
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber
      };
      
      await this.storage.saveShield(this.config.chainId, this.wallet, shield);
      
      // Update event counts
      const updatedCounts = createEventCounts({
        shield: currentCounts.shield + 1,
        remainder: currentCounts.remainder,
        received: currentCounts.received,
        consolidate: currentCounts.consolidate,
        lastUpdatedBlock: Math.max(receipt.blockNumber, currentCounts.lastUpdatedBlock)
      });
      
      await this.storage.saveEventCounts(this.config.chainId, this.wallet, updatedCounts);
      this.eventCounts = updatedCounts;
      
      // Save transaction record
      const transaction: Transaction = {
        nonce: shieldIndex, // HD index as nonce
        type: 'shield',
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: Date.now(),
        token: tokenAddress,
        amount: netAmount.toString(),
        commitment,
        fee: fee.toString(),
        derivationPath: `shield/${shieldIndex}`,
        hdIndex: shieldIndex,
        hdOperation: 'shield'
      };
      
      await this.storage.saveTransaction(this.config.chainId, this.wallet, transaction.nonce, transaction);
      
      return {
        success: true,
        txHash: receipt.hash,
        commitment,
        netAmount: netAmount.toString(),
        fee: fee.toString(),
        derivationPath: `shield/${shieldIndex}`,
        hdIndex: shieldIndex
      };
      
    } catch (error) {
      return {
        success: false,
        error: this.createError(error, 'Failed to shield tokens')
      };
    }
  }

  /**
   * Unshield (convert back to public) tokens with HD remainder handling
   */
  async unshield(
    secret: HexString, 
    amount: string, 
    recipient: string, 
    tokenAddress: string
  ): Promise<UnshieldResult> {
    this.ensureInitialized();
    
    try {
      // Validate inputs
      if (!CryptoService.isValidHexString(secret)) {
        throw new LaserGunError('Invalid secret format', ErrorCode.VALIDATION_ERROR);
      }
      
      if (!CryptoService.isValidAddress(recipient)) {
        throw new LaserGunError('Invalid recipient address', ErrorCode.VALIDATION_ERROR);
      }
      
      const parsedAmount = parseUnits(amount, await this.getTokenDecimals(tokenAddress));
      if (parsedAmount <= 0n) {
        throw new LaserGunError('Amount must be positive', ErrorCode.INVALID_AMOUNT);
      }
      
      // Check shield balance
      const shieldBalance = await this.contract.getShieldBalance(secret, tokenAddress);
      if (shieldBalance < parsedAmount) {
        throw new LaserGunError('Insufficient shield balance', ErrorCode.INSUFFICIENT_BALANCE);
      }
      
      // Calculate remainder and generate remainder commitment if needed
      const remainderAmount = shieldBalance - parsedAmount;
      let newCommitment = ZeroHash;
      let remainderDerivationPath: string | undefined;
      
      if (remainderAmount > 0n) {
        const currentCounts = await this.getCurrentEventCounts();
        const remainderIndex = currentCounts.remainder;
        const remainderSecret = this.hdManager!.deriveSecret('remainder', remainderIndex);
        newCommitment = CryptoService.generateCommitment(remainderSecret, this.wallet);
        remainderDerivationPath = `remainder/${remainderIndex}`;
      }
      
      // Execute unshield transaction
      const tx = await this.contract.unshield(secret, parsedAmount, recipient, newCommitment);
      const receipt = await tx.wait();
      
      // Calculate net amount after fees
      const feePercent = await this.contract.unshieldFeePercent();
      const feeDenominator = await this.contract.FEE_DENOMINATOR();
      const fee = parsedAmount * feePercent / feeDenominator;
      const netAmount = parsedAmount - fee;
      
      // Update event counts (increment remainder if remainder was created)
      const currentCounts = await this.getCurrentEventCounts();
      const updatedCounts = createEventCounts({
        shield: currentCounts.shield,
        remainder: remainderAmount > 0n ? currentCounts.remainder + 1 : currentCounts.remainder,
        received: currentCounts.received,
        consolidate: currentCounts.consolidate,
        lastUpdatedBlock: Math.max(receipt.blockNumber, currentCounts.lastUpdatedBlock)
      });
      
      await this.storage.saveEventCounts(this.config.chainId, this.wallet, updatedCounts);
      this.eventCounts = updatedCounts;
      
      // Save remainder shield if created
      if (remainderAmount > 0n && remainderDerivationPath) {
        const remainderIndex = currentCounts.remainder;
        const remainderSecret = this.hdManager!.deriveSecret('remainder', remainderIndex);
        
        const remainderShield: Shield = {
          secret: remainderSecret,
          commitment: newCommitment,
          token: tokenAddress,
          amount: remainderAmount.toString(),
          timestamp: Date.now(),
          derivationPath: remainderDerivationPath,
          hdIndex: remainderIndex,
          hdOperation: 'remainder',
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber
        };
        
        await this.storage.saveShield(this.config.chainId, this.wallet, remainderShield);
      }
      
      // Save transaction record
      const transaction: Transaction = {
        nonce: Date.now(), // Use timestamp for unshield nonce
        type: 'unshield',
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: Date.now(),
        token: tokenAddress,
        amount: netAmount.toString(),
        to: recipient,
        fee: fee.toString()
      };
      
      await this.storage.saveTransaction(this.config.chainId, this.wallet, transaction.nonce, transaction);
      
      return {
        success: true,
        txHash: receipt.hash,
        amount: netAmount.toString(),
        fee: fee.toString(),
        ...(remainderDerivationPath && { remainderDerivationPath })
      };
      
    } catch (error) {
      return {
        success: false,
        error: this.createError(error, 'Failed to unshield tokens')
      };
    }
  }

  /**
   * Transfer tokens privately to another user with HD remainder handling
   */
  async transfer(
    secret: HexString,
    amount: string,
    recipientAddress: string,
    tokenAddress: string
  ): Promise<TransferResult> {
    this.ensureInitialized();
    
    try {
      // Validate inputs
      if (!CryptoService.isValidHexString(secret)) {
        throw new LaserGunError('Invalid secret format', ErrorCode.VALIDATION_ERROR);
      }
      
      if (!CryptoService.isValidAddress(recipientAddress)) {
        throw new LaserGunError('Invalid recipient address', ErrorCode.VALIDATION_ERROR);
      }
      
      const parsedAmount = parseUnits(amount, await this.getTokenDecimals(tokenAddress));
      if (parsedAmount <= 0n) {
        throw new LaserGunError('Amount must be positive', ErrorCode.INVALID_AMOUNT);
      }
      
      // Check shield balance
      const shieldBalance = await this.contract.getShieldBalance(secret, tokenAddress);
      if (shieldBalance < parsedAmount) {
        throw new LaserGunError('Insufficient shield balance', ErrorCode.INSUFFICIENT_BALANCE);
      }
      
      // Get recipient's public key
      const recipientPublicKey = await this.contract.publicKeys(recipientAddress);
      if (!recipientPublicKey || recipientPublicKey === '0x') {
        throw new LaserGunError('Recipient has not registered public key', ErrorCode.VALIDATION_ERROR);
      }
      
      // Generate recipient commitment (recipient will use received/{theirIndex})
      const currentCounts = await this.getCurrentEventCounts();
      const receivedIndex = currentCounts.received; // This will be their received index
      const recipientSecret = this.hdManager!.deriveSecret('received', receivedIndex);
      const recipientCommitment = CryptoService.generateCommitment(recipientSecret, recipientAddress);
      
      // Encrypt secret for recipient
      const encryptedSecret = await CryptoService.encryptSecret(recipientSecret, recipientPublicKey as HexString);
      
      // Execute transfer transaction
      const tx = await this.contract.transfer(secret, parsedAmount, recipientCommitment, encryptedSecret);
      const receipt = await tx.wait();
      
      // Calculate remainder (transfer doesn't have fees) 
      let remainderDerivationPath: string | undefined;
      
      // If there's remainder, it will be created automatically by contract with userNonces
      // Scanner will detect and recover it later
      
      // Save transaction record
      const transaction: Transaction = {
        nonce: Date.now(), // Use timestamp for transfer nonce
        type: 'transfer',
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: Date.now(),
        token: tokenAddress,
        amount: parsedAmount.toString(),
        to: recipientAddress,
        commitment: recipientCommitment
      };
      
      await this.storage.saveTransaction(this.config.chainId, this.wallet, transaction.nonce, transaction);
      
      return {
        success: true,
        txHash: receipt.hash,
        recipientCommitment,
        amount: parsedAmount.toString(),
        ...(remainderDerivationPath && { remainderDerivationPath })
      };
      
    } catch (error) {
      return {
        success: false,
        error: this.createError(error, 'Failed to transfer tokens')
      };
    }
  }

  /**
   * Consolidate multiple shields into one with HD derivation
   */
  async consolidate(secrets: HexString[], tokenAddress: string): Promise<TransferResult> {
    this.ensureInitialized();
    
    try {
      // Validate inputs
      if (!secrets || secrets.length === 0) {
        throw new LaserGunError('No secrets provided', ErrorCode.VALIDATION_ERROR);
      }
      
      if (secrets.length > 10) {
        throw new LaserGunError('Too many shields to consolidate (max 10)', ErrorCode.VALIDATION_ERROR);
      }
      
      // Validate all secrets
      for (const secret of secrets) {
        if (!CryptoService.isValidHexString(secret)) {
          throw new LaserGunError('Invalid secret format', ErrorCode.VALIDATION_ERROR);
        }
      }
      
      // Check all shields exist and use same token
      let totalAmount = 0n;
      for (const secret of secrets) {
        const balance = await this.contract.getShieldBalance(secret, tokenAddress);
        if (balance === 0n) {
          throw new LaserGunError('Shield does not exist or already spent', ErrorCode.SHIELD_NOT_FOUND);
        }
        totalAmount += balance;
      }
      
      if (totalAmount === 0n) {
        throw new LaserGunError('Total amount must be positive', ErrorCode.INVALID_AMOUNT);
      }
      
      // Generate new commitment for consolidated shield using HD
      const currentCounts = await this.getCurrentEventCounts();
      const consolidateIndex = currentCounts.consolidate;
      const newSecret = this.hdManager!.deriveSecret('consolidate', consolidateIndex);
      const newCommitment = CryptoService.generateCommitment(newSecret, this.wallet);
      
      // Execute consolidate transaction
      const tx = await this.contract.consolidate(secrets, newCommitment);
      const receipt = await tx.wait();
      
      // Store consolidated shield with HD metadata
      const shield: Shield = {
        secret: newSecret,
        commitment: newCommitment,
        token: tokenAddress,
        amount: totalAmount.toString(),
        timestamp: Date.now(),
        derivationPath: `consolidate/${consolidateIndex}`,
        hdIndex: consolidateIndex,
        hdOperation: 'consolidate',
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber
      };
      
      await this.storage.saveShield(this.config.chainId, this.wallet, shield);
      
      // Update event counts
      const updatedCounts = createEventCounts({
        shield: currentCounts.shield,
        remainder: currentCounts.remainder,
        received: currentCounts.received,
        consolidate: currentCounts.consolidate + 1,
        lastUpdatedBlock: Math.max(receipt.blockNumber, currentCounts.lastUpdatedBlock)
      });
      
      await this.storage.saveEventCounts(this.config.chainId, this.wallet, updatedCounts);
      this.eventCounts = updatedCounts;
      
      // Save transaction record
      const transaction: Transaction = {
        nonce: consolidateIndex, // HD index as nonce
        type: 'transfer', // Consolidation is internal transfer
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: Date.now(),
        token: tokenAddress,
        amount: totalAmount.toString(),
        commitment: newCommitment,
        derivationPath: `consolidate/${consolidateIndex}`,
        hdIndex: consolidateIndex,
        hdOperation: 'consolidate'
      };
      
      await this.storage.saveTransaction(this.config.chainId, this.wallet, transaction.nonce, transaction);
      
      return {
        success: true,
        txHash: receipt.hash,
        recipientCommitment: newCommitment,
        amount: totalAmount.toString(),
        derivationPath: `consolidate/${consolidateIndex}`
      };
      
    } catch (error) {
      return {
        success: false,
        error: this.createError(error, 'Failed to consolidate shields')
      };
    }
  }

  /**
   * Get token balance (both public and private) with blockchain verification
   */
  async getTokenBalance(tokenAddress: string): Promise<TokenBalance> {
    this.ensureInitialized();
    
    try {
      // Check network connectivity
      await this.checkNetworkConnection();
      
      const tokenContract = new Contract(tokenAddress, LaserGun.ERC20_ABI, this.config.provider);
      
      // Get token info and public balance
      const [symbol, decimals, publicBalance] = await Promise.all([
        tokenContract.symbol(),
        tokenContract.decimals(),
        tokenContract.balanceOf(this.wallet)
      ]);
      
      // Calculate private balance from active shields
      let privateBalance = 0n;
      const shields = await this.storage.loadShields(this.config.chainId, this.wallet);
      
      for (const shield of shields) {
        if (shield.token.toLowerCase() === tokenAddress.toLowerCase()) {
          try {
            // Verify shield is still active on blockchain
            const isActive = await this.contract.isCommitmentActive(shield.commitment);
            if (isActive) {
              privateBalance += BigInt(shield.amount);
            }
          } catch {
            // Skip invalid shields
          }
        }
      }
      
      return {
        token: tokenAddress,
        symbol,
        decimals,
        publicBalance: publicBalance.toString(),
        privateBalance: privateBalance.toString()
      };
      
    } catch (error) {
      throw this.createError(error, 'Failed to get token balance');
    }
  }

  /**
   * Recover all data from blockchain using HD scanner
   */
  async recoverFromBlockchain(): Promise<{
    shieldsRecovered: number;
    transactionsRecovered: number;
  }> {
    this.ensureInitialized();
    
    try {
      await this.checkNetworkConnection();
      
      // Use scanner's HD recovery mechanism
      await this.scanner.recoverFromBlockchain();
      
      // Reload event counts after recovery
      this.eventCounts = await this.storage.loadEventCounts(this.config.chainId, this.wallet);
      
      // Get counts for reporting
      const shields = await this.storage.loadShields(this.config.chainId, this.wallet);
      const transactions = await this.storage.loadTransactions(this.config.chainId, this.wallet);
      
      return {
        shieldsRecovered: shields.length,
        transactionsRecovered: transactions.length
      };
      
    } catch (error) {
      throw this.createError(error, 'Failed to recover from blockchain');
    }
  }

  /**
   * Get transaction history
   */
  async getTransactionHistory(): Promise<Transaction[]> {
    this.ensureInitialized();
    
    try {
      return await this.storage.loadTransactions(this.config.chainId, this.wallet);
    } catch (error) {
      throw this.createError(error, 'Failed to load transaction history');
    }
  }

  /**
   * Get all user shields
   */
  async getUserShields(): Promise<Shield[]> {
    this.ensureInitialized();
    
    try {
      return await this.storage.loadShields(this.config.chainId, this.wallet);
    } catch (error) {
      throw this.createError(error, 'Failed to load user shields');
    }
  }

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
   * Get current event counts
   */
  async getEventCounts(): Promise<EventCounts> {
    return await this.getCurrentEventCounts();
  }

  // Private helper methods

  private validateConfig(config: LaserGunConfig): void {
    if (!config.contractAddress || !CryptoService.isValidAddress(config.contractAddress)) {
      throw new LaserGunError('Invalid contract address', ErrorCode.INVALID_CONFIG);
    }
    
    if (!config.provider) {
      throw new LaserGunError('Provider is required', ErrorCode.INVALID_CONFIG);
    }
    
    if (!config.signer) {
      throw new LaserGunError('Signer is required', ErrorCode.INVALID_CONFIG);
    }
    
    if (!config.chainId || config.chainId <= 0) {
      throw new LaserGunError('Invalid chain ID', ErrorCode.INVALID_CONFIG);
    }
  }

  private ensureInitialized(): void {
    if (!this.wallet || !this.keys || !this.hdManager) {
      throw new LaserGunError('LaserGun not initialized. Call initialize() first.', ErrorCode.INVALID_CONFIG);
    }
  }

  private async generateNewKeys(): Promise<CryptoKeys> {
    return await CryptoService.generateKeys(
      this.config.signer,
      this.config.chainId,
      0,
      this.config.signMessage
    );
  }

  private async ensurePublicKeyRegistered(): Promise<void> {
    if (!this.keys) return;
    
    const registeredKey = await this.contract.publicKeys(this.wallet);
    
    if (!registeredKey || registeredKey === '0x') {
      const tx = await this.contract.registerPublicKey(this.keys.publicKey);
      await tx.wait();
    }
  }

  private async getCurrentEventCounts(): Promise<EventCounts> {
    if (this.eventCounts) {
      return this.eventCounts;
    }
    
    // Load or create default event counts
    this.eventCounts = await this.storage.loadEventCounts(this.config.chainId, this.wallet) || createEventCounts({
      lastUpdatedBlock: await this.config.provider.getBlockNumber()
    });
    
    return this.eventCounts;
  }

  private async getTokenDecimals(tokenAddress: string): Promise<number> {
    const tokenContract = new Contract(tokenAddress, LaserGun.ERC20_ABI, this.config.provider);
    return await tokenContract.decimals();
  }

  private async checkTokenBalance(tokenAddress: string, amount: bigint): Promise<void> {
    const tokenContract = new Contract(tokenAddress, LaserGun.ERC20_ABI, this.config.provider);
    const balance = await tokenContract.balanceOf(this.wallet);
    
    if (balance < amount) {
      throw new LaserGunError('Insufficient token balance', ErrorCode.INSUFFICIENT_BALANCE);
    }
  }

  private async ensureAllowance(tokenAddress: string, amount: bigint): Promise<void> {
    const tokenContract = new Contract(tokenAddress, LaserGun.ERC20_ABI, this.config.signer);
    const allowance = await tokenContract.allowance(this.wallet, this.config.contractAddress);
    
    if (allowance < amount) {
      const tx = await tokenContract.approve(this.config.contractAddress, amount);
      await tx.wait();
    }
  }

  private async checkNetworkConnection(): Promise<void> {
    try {
      const network = await this.config.provider.getNetwork();
      if (Number(network.chainId) !== this.config.chainId) {
        throw new LaserGunError(
          `Network mismatch. Expected ${this.config.chainId}, got ${network.chainId}`,
          ErrorCode.NETWORK_ERROR
        );
      }
    } catch (error) {
      if (error instanceof LaserGunError) {
        throw error;
      }
      throw new LaserGunError(
        'Failed to connect to network',
        ErrorCode.NETWORK_ERROR,
        error
      );
    }
  }
 
  private createError(error: unknown, message: string): LaserGunError {
    if (error instanceof LaserGunError) {
      return error;
    }
    
    return new LaserGunError(
      `${message}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      ErrorCode.CONTRACT_ERROR,
      error
    );
  }
}