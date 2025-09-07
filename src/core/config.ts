import { Contract } from 'ethers';
import type { LaserGunConfig, CryptoKeys } from '../types';
import { LaserGunError, ErrorCode } from '../types';
import { CryptoService } from '../crypto';

/**
 * Configuration and validation module for LaserGun
 */
export class LaserGunConfigManager {
  private readonly config: LaserGunConfig;
  private readonly contract: Contract;
  private keys: CryptoKeys | null = null;
  private wallet: string = '';

  // LaserGun contract ABI
  static readonly CONTRACT_ABI = [
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
    'function transferFeePercent() external view returns (uint256)',
    'function FEE_DENOMINATOR() external view returns (uint256)',
    
    // Events
    'event Shielded(bytes32 indexed commitment, address indexed token, uint256 amount, uint256 fee)',
    'event Unshielded(bytes32 indexed commitment, address indexed token, uint256 amount, uint256 fee)',
    'event SecretDelivered(bytes encryptedSecret)',
    'event ShieldConsolidated(bytes32[] indexed oldCommitments, bytes32 indexed newCommitment)'
  ];

  // Standard ERC20 ABI for token operations
  static readonly ERC20_ABI = [
    'function balanceOf(address owner) external view returns (uint256)',
    'function allowance(address owner, address spender) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function symbol() external view returns (string)',
    'function decimals() external view returns (uint8)',
    'function name() external view returns (string)'
  ];

  constructor(config: LaserGunConfig) {
    this.validateConfig(config);
    this.config = config;
    this.contract = new Contract(config.contractAddress, LaserGunConfigManager.CONTRACT_ABI, config.signer);
  }

  /**
   * Validate LaserGun configuration
   */
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

  /**
   * Initialize wallet and keys
   */
  async initializeWallet(): Promise<{ wallet: string; keys: CryptoKeys }> {
    this.wallet = (await this.config.signer.getAddress()).toLowerCase();
    
    if (!this.keys) {
      this.keys = await this.generateNewKeys();
    }
    
    return { wallet: this.wallet, keys: this.keys };
  }

  /**
   * Set keys (from storage or generation)
   */
  setKeys(keys: CryptoKeys): void {
    this.keys = keys;
  }

  /**
   * Generate new crypto keys
   */
  async generateNewKeys(): Promise<CryptoKeys> {
    return await CryptoService.generateKeys(
      this.config.signer,
      this.config.chainId,
      0,
      this.config.signMessage
    );
  }

  /**
   * Check network connectivity and chain ID
   */
  async checkNetworkConnection(): Promise<void> {
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

  /**
   * Ensure public key is registered on contract
   */
  async ensurePublicKeyRegistered(): Promise<void> {
    if (!this.keys || !this.wallet) return;
    
    const registeredKey = await this.contract.publicKeys(this.wallet);
    
    if (!registeredKey || registeredKey === '0x') {
      const tx = await this.contract.registerPublicKey(this.keys.publicKey);
      await tx.wait();
    }
  }

  // Getters
  getConfig(): LaserGunConfig { return this.config; }
  getContract(): Contract { return this.contract; }
  getKeys(): CryptoKeys | null { return this.keys; }
  getWallet(): string { return this.wallet; }
}