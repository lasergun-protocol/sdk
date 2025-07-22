import { Contract,  parseUnits, ZeroHash } from 'ethers';
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
  HexString
} from '../types';
import { LaserGunError, ErrorCode } from '../types';
import { CryptoService } from '../crypto';
import { EventScanner } from './scanner';

/**
 * Main LaserGun SDK class
 * Provides privacy-preserving ERC20 operations with shield/unshield/transfer functionality
 */
export default class LaserGun {
  private readonly config: LaserGunConfig;
  private readonly contract: Contract;
  private readonly storage: IStorageAdapter;
  private readonly scanner: EventScanner;
  
  private keys: CryptoKeys | null = null;
  private wallet: string = '';

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
   * Initialize LaserGun for specific wallet
   */
  async initialize(): Promise<void> {
    try {
      this.wallet = (await this.config.signer.getAddress()).toLowerCase();
      
      // Load existing keys or generate new ones
      this.keys = await this.storage.loadKeys(this.config.chainId, this.wallet);
      
      if (!this.keys) {
        this.keys = await this.generateNewKeys();
        await this.storage.saveKeys(this.config.chainId, this.wallet, this.keys);
      }
      
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
   * Shield (privatize) ERC20 tokens
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
      
      // Generate secret and commitment
      const nonce = await this.getNextNonce();
      const secret = CryptoService.generateSecret(this.keys!.privateKey as HexString, nonce);
      const commitment = CryptoService.generateCommitment(secret, this.wallet);
      
      // Execute shield transaction
      const tx = await this.contract.shield(parsedAmount, tokenAddress, commitment);
      const receipt = await tx.wait();
      
      // Calculate net amount after fees
      const feePercent = await this.contract.shieldFeePercent();
      const feeDenominator = await this.contract.FEE_DENOMINATOR();
      const fee = parsedAmount * feePercent / feeDenominator;
      const netAmount = parsedAmount - fee;
      
      // Store shield locally
      const shield: Shield = {
        secret,
        commitment,
        token: tokenAddress,
        amount: netAmount.toString(),
        timestamp: Date.now()
      };
      
      await this.storage.saveShield(this.config.chainId, this.wallet, shield);
      
      // Save transaction record
      const transaction: Transaction = {
        nonce,
        type: 'shield',
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: Date.now(),
        token: tokenAddress,
        amount: netAmount.toString(),
        commitment,
        fee: fee.toString()
      };
      
      await this.storage.saveTransaction(this.config.chainId, this.wallet, transaction.nonce, transaction);
      
      return {
        success: true,
        txHash: receipt.hash,
        commitment,
        netAmount: netAmount.toString(),
        fee: fee.toString()
      };
      
    } catch (error) {
      return {
        success: false,
        error: this.createError(error, 'Failed to shield tokens')
      };
    }
  }

  /**
   * Unshield (convert back to public) tokens
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
      
      // Generate new commitment for remainder (if any)
      const remainderAmount = shieldBalance - parsedAmount;
      let newCommitment = ZeroHash;
      
      if (remainderAmount > 0n) {
        const remainderNonce = await this.getNextNonce();
        const remainderSecret = CryptoService.generateSecret(this.keys!.privateKey as HexString, remainderNonce);
        newCommitment = CryptoService.generateCommitment(remainderSecret, this.wallet);
      }
      
      // Execute unshield transaction
      const tx = await this.contract.unshield(secret, parsedAmount, recipient, newCommitment);
      const receipt = await tx.wait();
      
      // Calculate net amount after fees
      const feePercent = await this.contract.unshieldFeePercent();
      const feeDenominator = await this.contract.FEE_DENOMINATOR();
      const fee = parsedAmount * feePercent / feeDenominator;
      const netAmount = parsedAmount - fee;
      
      // Save transaction record
      const transactionNonce = await this.getNextNonce();
      const transaction: Transaction = {
        nonce: transactionNonce,
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
        ...(remainderAmount > 0n && { remainderCommitment: newCommitment })
      };
      
    } catch (error) {
      return {
        success: false,
        error: this.createError(error, 'Failed to unshield tokens')
      };
    }
  }

  /**
   * Transfer tokens privately to another user
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
      
      // Generate commitments
      const recipientNonce = await this.getNextNonce();
      const recipientSecret = CryptoService.generateSecret(this.keys!.privateKey as HexString, recipientNonce);
      const recipientCommitment = CryptoService.generateCommitment(recipientSecret, recipientAddress);
      
      // Encrypt secret for recipient
      const encryptedSecret = await CryptoService.encryptSecret(recipientSecret, recipientPublicKey as HexString);
      
      // Execute transfer transaction
      const tx = await this.contract.transfer(secret, parsedAmount, recipientCommitment, encryptedSecret);
      const receipt = await tx.wait();
      
      // Save transaction record
      const transactionNonce = await this.getNextNonce();
      const transaction: Transaction = {
        nonce: transactionNonce,
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
        amount: parsedAmount.toString()
      };
      
    } catch (error) {
      return {
        success: false,
        error: this.createError(error, 'Failed to transfer tokens')
      };
    }
  }

  /**
   * Consolidate multiple shields into one
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
      
      // Generate new commitment for consolidated shield
      const consolidateNonce = await this.getNextNonce();
      const newSecret = CryptoService.generateSecret(this.keys!.privateKey as HexString, consolidateNonce);
      const newCommitment = CryptoService.generateCommitment(newSecret, this.wallet);
      
      // Execute consolidate transaction
      const tx = await this.contract.consolidate(secrets, newCommitment);
      const receipt = await tx.wait();
      
      // Save transaction record
      const transactionNonce = await this.getNextNonce();
      const transaction: Transaction = {
        nonce: transactionNonce,
        type: 'transfer', // Consolidation is a type of internal transfer
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: Date.now(),
        token: tokenAddress,
        amount: totalAmount.toString(),
        commitment: newCommitment
      };
      
      await this.storage.saveTransaction(this.config.chainId, this.wallet, transaction.nonce, transaction);
      
      return {
        success: true,
        txHash: receipt.hash,
        recipientCommitment: newCommitment,
        amount: totalAmount.toString()
      };
      
    } catch (error) {
      return {
        success: false,
        error: this.createError(error, 'Failed to consolidate shields')
      };
    }
  }

  /**
   * Get token balance (both public and private)
   */
  async getTokenBalance(tokenAddress: string): Promise<TokenBalance> {
    this.ensureInitialized();
    
    try {
      // Check network connectivity
      await this.checkNetworkConnection();
      
      const tokenContract = new Contract(tokenAddress, LaserGun.ERC20_ABI, this.config.provider);
      
      // Get token info
      const [symbol, decimals, publicBalance, transactions] = await Promise.all([
        tokenContract.symbol(),
        tokenContract.decimals(),
        tokenContract.balanceOf(this.wallet),
          this.storage.loadTransactions(this.config.chainId, this.wallet)
      ]);
      
      // Calculate private balance from active shields only
      let privateBalance = 0n;

      
      // Get all shield commitments from our transactions
      const shieldCommitments = new Set<string>();
      
      for (const tx of transactions) {
        if (tx.token.toLowerCase() === tokenAddress.toLowerCase() && tx.commitment) {
          if (tx.type === 'shield' || tx.type === 'received') {
            shieldCommitments.add(tx.commitment);
          }
        }
      }
      
      // Check each commitment to see if it's still active and get actual balance
      for (const commitment of shieldCommitments) {
        try {
          const isActive = await this.contract.isCommitmentActive(commitment);
          if (isActive) {
            const shieldInfo = await this.contract.getShieldInfo(commitment);
            if (shieldInfo.exists && !shieldInfo.spent && shieldInfo.token.toLowerCase() === tokenAddress.toLowerCase()) {
              privateBalance += BigInt(shieldInfo.amount.toString());
            }
          }
        } catch (error) {
          // Skip invalid commitments
          continue;
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
   * Get shields for specific token
   */
  async getTokenShields(tokenAddress: string): Promise<Shield[]> {
    this.ensureInitialized();
    
    try {
      const allShields = await this.storage.loadShields(this.config.chainId, this.wallet);
      return allShields.filter(shield => 
        shield.token.toLowerCase() === tokenAddress.toLowerCase()
      );
    } catch (error) {
      throw this.createError(error, 'Failed to load token shields');
    }
  }

  /**
   * Clean up spent shields from storage
   */
  async cleanupSpentShields(): Promise<void> {
    this.ensureInitialized();
    
    try {
      await this.checkNetworkConnection();
      
      const shields = await this.storage.loadShields(this.config.chainId, this.wallet);
      
      for (const shield of shields) {
        try {
          const isActive = await this.contract.isCommitmentActive(shield.commitment);
          if (!isActive) {
            await this.storage.deleteShield(this.config.chainId, this.wallet, shield.commitment);
          }
        } catch (error) {
          // Skip shield if we can't check its status
          continue;
        }
      }
    } catch (error) {
      throw this.createError(error, 'Failed to cleanup spent shields');
    }
  }

  /**
   * Start event scanner
   */
  async startScanner(): Promise<void> {
    this.ensureInitialized();
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
    if (!this.wallet || !this.keys) {
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

  private async getNextNonce(): Promise<number> {
    return await this.storage.getLastNonce(this.config.chainId, this.wallet) + 1;
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