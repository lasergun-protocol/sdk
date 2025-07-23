import { Contract } from 'ethers';
import type { IStorageAdapter, TokenBalance } from '../types';
import { LaserGunError, ErrorCode } from '../types';
import { LaserGunConfigManager } from '../core/config';

/**
 * Token-related operations module
 * Handles ERC20 token interactions, balances, and allowances
 */
export class TokenManager {
  private readonly configManager: LaserGunConfigManager;
  private readonly storage: IStorageAdapter;

  constructor(configManager: LaserGunConfigManager, storage: IStorageAdapter) {
    this.configManager = configManager;
    this.storage = storage;
  }

  /**
   * Get token decimals
   */
  async getTokenDecimals(tokenAddress: string): Promise<number> {
    const tokenContract = new Contract(
      tokenAddress, 
      LaserGunConfigManager.ERC20_ABI, 
      this.configManager.getConfig().provider
    );
    return await tokenContract.decimals();
  }

  /**
   * Check if user has sufficient token balance
   */
  async checkTokenBalance(tokenAddress: string, amount: bigint): Promise<void> {
    const tokenContract = new Contract(
      tokenAddress, 
      LaserGunConfigManager.ERC20_ABI, 
      this.configManager.getConfig().provider
    );
    
    const balance = await tokenContract.balanceOf(this.configManager.getWallet());
    
    if (balance < amount) {
      throw new LaserGunError('Insufficient token balance', ErrorCode.INSUFFICIENT_BALANCE);
    }
  }

  /**
   * Ensure sufficient allowance for LaserGun contract
   */
  async ensureAllowance(tokenAddress: string, amount: bigint): Promise<void> {
    const tokenContract = new Contract(
      tokenAddress, 
      LaserGunConfigManager.ERC20_ABI, 
      this.configManager.getConfig().signer
    );
    
    const allowance = await tokenContract.allowance(
      this.configManager.getWallet(), 
      this.configManager.getConfig().contractAddress
    );
    
    if (allowance < amount) {
      const tx = await tokenContract.approve(this.configManager.getConfig().contractAddress, amount);
      await tx.wait();
    }
  }

  /**
   * Get token balance (both public and private) with blockchain verification
   */
  async getTokenBalance(tokenAddress: string): Promise<TokenBalance> {
    try {
      // Check network connectivity
      await this.configManager.checkNetworkConnection();
      
      const tokenContract = new Contract(
        tokenAddress, 
        LaserGunConfigManager.ERC20_ABI, 
        this.configManager.getConfig().provider
      );
      
      // Get token info and public balance
      const [symbol, decimals, publicBalance] = await Promise.all([
        tokenContract.symbol(),
        tokenContract.decimals(),
        tokenContract.balanceOf(this.configManager.getWallet())
      ]);
      
      // Calculate private balance from active shields
      let privateBalance = 0n;
      const shields = await this.storage.loadShields(
        this.configManager.getConfig().chainId, 
        this.configManager.getWallet()
      );
      
      const contract = this.configManager.getContract();
      
      for (const shield of shields) {
        if (shield.token.toLowerCase() === tokenAddress.toLowerCase()) {
          try {
            // Use commitment for verification
            const isActive = await contract.isCommitmentActive(shield.commitment);
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
      throw new LaserGunError(
        `Failed to get token balance: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.CONTRACT_ERROR,
        error
      );
    }
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
    try {
      const tokenContract = new Contract(
        tokenAddress, 
        LaserGunConfigManager.ERC20_ABI, 
        this.configManager.getConfig().provider
      );
      
      const [name, symbol, decimals] = await Promise.all([
        tokenContract.name(),
        tokenContract.symbol(),
        tokenContract.decimals()
      ]);
      
      return {
        address: tokenAddress,
        name,
        symbol,
        decimals
      };
      
    } catch (error) {
      throw new LaserGunError(
        `Failed to get token info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.CONTRACT_ERROR,
        error
      );
    }
  }

  /**
   * Check if address is a valid ERC20 token
   */
  async isValidToken(tokenAddress: string): Promise<boolean> {
    try {
      await this.getTokenInfo(tokenAddress);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get user's public token allowance for LaserGun contract
   */
  async getAllowance(tokenAddress: string): Promise<string> {
    try {
      const tokenContract = new Contract(
        tokenAddress, 
        LaserGunConfigManager.ERC20_ABI, 
        this.configManager.getConfig().provider
      );
      
      const allowance = await tokenContract.allowance(
        this.configManager.getWallet(),
        this.configManager.getConfig().contractAddress
      );
      
      return allowance.toString();
      
    } catch (error) {
      throw new LaserGunError(
        `Failed to get allowance: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.CONTRACT_ERROR,
        error
      );
    }
  }
}