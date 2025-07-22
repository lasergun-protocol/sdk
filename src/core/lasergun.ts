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
import { EventLog } from 'ethers';

/**
 * Main LaserGun SDK class
 * Provides privacy-preserving ERC20 operations with shield/unshield/transfer functionality
 * FIXED: Now includes blockchain recovery capabilities
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
   * Recover all data from blockchain (shields, transactions)
   * Call this after localStorage clear or when switching devices
   */
  async recoverFromBlockchain(): Promise<{
    shieldsRecovered: number;
    transactionsRecovered: number;
  }> {
    this.ensureInitialized();
    
    try {
      await this.checkNetworkConnection();
      
      // Use scanner's recovery mechanism
      await this.scanner.recoverFromBlockchain();
      
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
   * Check if we can recover a specific commitment
   */
  async canRecoverCommitment(commitment: string): Promise<{
    canRecover: boolean;
    secret?: string;
    nonce?: number;
  }> {
    this.ensureInitialized();
    
    if (!this.keys) {
      return { canRecover: false };
    }

    try {
      // Check up to reasonable nonce limit
      const maxNonce = Math.max(await this.storage.getLastNonce(this.config.chainId, this.wallet) + 100, 1000);
      
      for (let nonce = 0; nonce <= maxNonce; nonce++) {
        const secret = CryptoService.generateSecret(this.keys.privateKey as HexString, nonce);
        const testCommitment = CryptoService.generateCommitment(secret, this.wallet);
        
        if (testCommitment === commitment) {
          return {
            canRecover: true,
            secret,
            nonce
          };
        }
      }
      
      return { canRecover: false };
      
    } catch (error) {
      throw this.createError(error, 'Failed to check commitment recovery');
    }
  }

  /**
   * Get all active shields from blockchain (not from local storage)
   * This queries the contract directly for current state
   */
  async getActiveShieldsFromBlockchain(): Promise<Array<{
    commitment: string;
    token: string;
    amount: string;
    timestamp: number;
    secret?: string;
    nonce?: number;
  }>> {
    this.ensureInitialized();
    
    try {
      await this.checkNetworkConnection();
      
      const result: Array<{
        commitment: string;
        token: string;
        amount: string;
        timestamp: number;
        secret?: string;
        nonce?: number;
      }> = [];
      
      // Get all Shielded events
      const latestBlock = await this.config.provider.getBlockNumber();
      const shieldedEvents = await this.contract.queryFilter(
        this.contract.filters.Shielded(),
        0,
        latestBlock
      );
      
      for (const event of shieldedEvents) {
        const commitment = (event as EventLog).args.commitment;
        
        // Check if shield is still active
        const isActive = await this.contract.isCommitmentActive(commitment);
        if (!isActive) continue;
        
        const shieldInfo = await this.contract.getShieldInfo(commitment);
        if (!shieldInfo.exists || shieldInfo.spent) continue;
        
        // Check if this is our commitment
        const recoveryInfo = await this.canRecoverCommitment(commitment);
        
        result.push({
          commitment,
          token: shieldInfo.token,
          amount: shieldInfo.amount.toString(),
          timestamp: Number(shieldInfo.timestamp) * 1000,
          ...(recoveryInfo.canRecover && {
            secret: recoveryInfo.secret,
            nonce: recoveryInfo.nonce
          })
        });
      }
      
      return result;
      
    } catch (error) {
      throw this.createError(error, 'Failed to get active shields from blockchain');
    }
  }

  /**
   * Sync local storage with blockchain state
   * This ensures our local data matches blockchain reality
   */
  async syncWithBlockchain(): Promise<{
    added: number;
    removed: number;
    updated: number;
  }> {
    this.ensureInitialized();
    
    try {
      const stats = { added: 0, removed: 0, updated: 0 };
      
      // First recover any missing data
      await this.recoverFromBlockchain();
      
      // Get our local shields
      const localShields = await this.storage.loadShields(this.config.chainId, this.wallet);
      
      // Check each local shield against blockchain
      for (const localShield of localShields) {
        const isActive = await this.contract.isCommitmentActive(localShield.commitment);
        
        if (!isActive) {
          // Shield was spent, remove from local storage
          await this.storage.deleteShield(this.config.chainId, this.wallet, localShield.commitment);
          stats.removed++;
        }
      }
      
      // Get blockchain shields and ensure we have them locally
      const blockchainShields = await this.getActiveShieldsFromBlockchain();
      
      for (const blockchainShield of blockchainShields) {
        if (blockchainShield.secret && blockchainShield.nonce !== undefined) {
          // This is our shield, check if we have it locally
          const localShield = await this.storage.getShield(this.config.chainId, this.wallet, blockchainShield.commitment);
          
          if (!localShield) {
            // Add missing shield
            const shield: Shield = {
              secret: blockchainShield.secret,
              commitment: blockchainShield.commitment,
              token: blockchainShield.token,
              amount: blockchainShield.amount,
              timestamp: blockchainShield.timestamp
            };
            
            await this.storage.saveShield(this.config.chainId, this.wallet, shield);
            stats.added++;
          } else if (localShield.amount !== blockchainShield.amount) {
            // Update amount if different (shouldn't happen but just in case)
            const updatedShield: Shield = {
              ...localShield,
              amount: blockchainShield.amount
            };
            
            await this.storage.saveShield(this.config.chainId, this.wallet, updatedShield);
            stats.updated++;
          }
        }
      }
      
      return stats;
      
    } catch (error) {
      throw this.createError(error, 'Failed to sync with blockchain');
    }
  }

  /**
   * Get comprehensive balance that always reflects blockchain reality
   */
  async getTokenBalanceFromBlockchain(tokenAddress: string): Promise<TokenBalance & {
    activeShields: Array<{
      commitment: string;
      amount: string;
      timestamp: number;
    }>;
  }> {
    this.ensureInitialized();
    
    try {
      await this.checkNetworkConnection();
      
      const tokenContract = new Contract(tokenAddress, LaserGun.ERC20_ABI, this.config.provider);
      
      // Get token info and public balance
      const [symbol, decimals, publicBalance] = await Promise.all([
        tokenContract.symbol(),
        tokenContract.decimals(),
        tokenContract.balanceOf(this.wallet)
      ]);
      
      // Get our active shields from blockchain
      const blockchainShields = await this.getActiveShieldsFromBlockchain();
      
      // Calculate private balance and collect active shields for this token
      let privateBalance = 0n;
      const activeShields: Array<{
        commitment: string;
        amount: string;
        timestamp: number;
      }> = [];
      
      for (const shield of blockchainShields) {
        if (shield.token.toLowerCase() === tokenAddress.toLowerCase() && shield.secret) {
          const amount = BigInt(shield.amount);
          privateBalance += amount;
          
          activeShields.push({
            commitment: shield.commitment,
            amount: shield.amount,
            timestamp: shield.timestamp
          });
        }
      }
      
      return {
        token: tokenAddress,
        symbol,
        decimals,
        publicBalance: publicBalance.toString(),
        privateBalance: privateBalance.toString(),
        activeShields
      };
      
    } catch (error) {
      throw this.createError(error, 'Failed to get token balance from blockchain');
    }
  }

  /**
   * Emergency recovery: scan entire blockchain for our commitments
   * Use this if you suspect data loss or corruption
   */
  async emergencyRecovery(fromBlock: number = 0): Promise<{
    shieldsFound: number;
    transactionsCreated: number;
    errors: string[];
  }> {
    this.ensureInitialized();
    
    try {
      const stats = {
        shieldsFound: 0,
        transactionsCreated: 0,
        errors: [] as string[]
      };
      
      console.log('Starting emergency recovery from blockchain...');
      
      const latestBlock = await this.config.provider.getBlockNumber();
      const batchSize = 10000;
      
      // Generate our possible secrets cache (extended range)
      const maxNonce = Math.max(await this.storage.getLastNonce(this.config.chainId, this.wallet) + 200, 2000);
      const ourCommitments = new Map<string, {secret: HexString, nonce: number}>();
      
      console.log(`Generating ${maxNonce} possible secrets...`);
      
      for (let nonce = 0; nonce <= maxNonce; nonce++) {
        const secret = CryptoService.generateSecret(this.keys!.privateKey as HexString, nonce);
        const commitment = CryptoService.generateCommitment(secret, this.wallet);
        ourCommitments.set(commitment, { secret, nonce });
      }
      
      console.log(`Scanning blocks ${fromBlock} to ${latestBlock}...`);
      
      // Scan in batches
      for (let blockStart = fromBlock; blockStart <= latestBlock; blockStart += batchSize) {
        const blockEnd = Math.min(blockStart + batchSize - 1, latestBlock);
        
        try {
          console.log(`Scanning blocks ${blockStart}-${blockEnd}...`);
          
          // Get all Shielded events in this batch
          const shieldedEvents = await this.contract.queryFilter(
            this.contract.filters.Shielded(),
            blockStart,
            blockEnd
          );
          
          for (const event of shieldedEvents) {
            const commitment = (event as EventLog).args.commitment;
            const ourCommitment = ourCommitments.get(commitment);
            
            if (ourCommitment) {
              // This is our shield!
              console.log(`Found our shield: ${commitment}`);
              
              // Check if we already have it
              const existingShield = await this.storage.getShield(this.config.chainId, this.wallet, commitment);
              
              if (!existingShield) {
                // Save shield
                const shield: Shield = {
                  secret: ourCommitment.secret,
                  commitment: commitment,
                  token: (event as EventLog).args.token,
                  amount: (event as EventLog).args.amount.toString(),
                  timestamp: Date.now()
                };
                
                await this.storage.saveShield(this.config.chainId, this.wallet, shield);
                stats.shieldsFound++;
                
                // Create transaction record
                const block = await this.config.provider.getBlock(event.blockNumber);
                const timestamp = block ? block.timestamp * 1000 : Date.now();
                
                const transaction: Transaction = {
                  nonce: ourCommitment.nonce,
                  type: 'shield',
                  txHash: event.transactionHash,
                  blockNumber: event.blockNumber,
                  timestamp: timestamp,
                  token: (event as EventLog).args.token,
                  amount: (event as EventLog).args.amount.toString(),
                  commitment: commitment,
                  fee: (event as EventLog).args.fee.toString()
                };
                
                await this.storage.saveTransaction(this.config.chainId, this.wallet, transaction.nonce, transaction);
                stats.transactionsCreated++;
              }
            }
          }
          
        } catch (error) {
          const errorMsg = `Failed to scan blocks ${blockStart}-${blockEnd}: ${error instanceof Error ? error.message : 'Unknown error'}`;
          stats.errors.push(errorMsg);
          console.error(errorMsg);
        }
        
        // Small delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      console.log('Emergency recovery completed:', stats);
      return stats;
      
    } catch (error) {
      throw this.createError(error, 'Emergency recovery failed');
    }
  }

  /**
   * Validate data integrity between local storage and blockchain
   */
  async validateDataIntegrity(): Promise<{
    isValid: boolean;
    issues: string[];
    suggestions: string[];
  }> {
    this.ensureInitialized();
    
    const result = {
      isValid: true,
      issues: [] as string[],
      suggestions: [] as string[]
    };
    
    try {
      // Check if all local shields exist and are active on blockchain
      const localShields = await this.storage.loadShields(this.config.chainId, this.wallet);
      
      for (const shield of localShields) {
        const isActive = await this.contract.isCommitmentActive(shield.commitment);
        
        if (!isActive) {
          result.isValid = false;
          result.issues.push(`Shield ${shield.commitment} is inactive on blockchain but exists locally`);
          result.suggestions.push(`Run syncWithBlockchain() to clean up spent shields`);
        }
        
        const shieldInfo = await this.contract.getShieldInfo(shield.commitment);
        if (shieldInfo.exists && shieldInfo.amount.toString() !== shield.amount) {
          result.isValid = false;
          result.issues.push(`Shield ${shield.commitment} amount mismatch: local=${shield.amount}, blockchain=${shieldInfo.amount}`);
          result.suggestions.push(`Run syncWithBlockchain() to update amounts`);
        }
      }
      
      // Check if we're missing any shields from blockchain
      const blockchainShields = await this.getActiveShieldsFromBlockchain();
      const localCommitments = new Set(localShields.map(s => s.commitment));
      
      for (const blockchainShield of blockchainShields) {
        if (blockchainShield.secret && !localCommitments.has(blockchainShield.commitment)) {
          result.isValid = false;
          result.issues.push(`Missing shield ${blockchainShield.commitment} from local storage`);
          result.suggestions.push(`Run recoverFromBlockchain() to restore missing shields`);
        }
      }
      
      if (result.isValid) {
        result.suggestions.push('Data integrity is good!');
      }
      
    } catch (error) {
      result.isValid = false;
      result.issues.push(`Failed to validate data integrity: ${error instanceof Error ? error.message : 'Unknown error'}`);
      result.suggestions.push('Check network connection and try again');
    }
    
    return result;
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