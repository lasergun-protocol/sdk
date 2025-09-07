import { Contract } from 'ethers';
import type { HexString } from '../types';
import { ErrorHelpers } from './errorHelpers';
import { ErrorCode } from '../types';

/**
 * Contract interaction helpers with error handling and common patterns
 * Provides consistent contract operation patterns across all modules
 */
export class ContractHelpers {

  /**
   * Get shield info with error handling
   */
  static async getShieldInfoSafely(
    contract: Contract,
    commitment: HexString
  ): Promise<{
    exists: boolean;
    token: string;
    amount: bigint;
    timestamp: bigint;
    spent: boolean;
  }> {
    try {
      const info = await contract.getShieldInfo(commitment);
      return {
        exists: info.exists,
        token: info.token,
        amount: info.amount,
        timestamp: info.timestamp,
        spent: info.spent
      };
    } catch (error) {
      throw ErrorHelpers.createError(
        error,
        `Failed to get shield info for commitment ${commitment.slice(0, 10)}...`,
        ErrorCode.CONTRACT_ERROR
      );
    }
  }

  /**
   * Check if commitment is active with error handling
   */
  static async isCommitmentActiveSafely(
    contract: Contract,
    commitment: HexString
  ): Promise<boolean> {
    try {
      return await contract.isCommitmentActive(commitment);
    } catch (error) {
      // If we can't check, assume inactive for safety
      console.warn(`Failed to check commitment activity for ${commitment.slice(0, 10)}...:`, error);
      return false;
    }
  }

  /**
   * Get shield balance with error handling
   */
  static async getShieldBalanceSafely(
    contract: Contract,
    secret: HexString,
    tokenAddress: string
  ): Promise<bigint> {
    try {
      return await contract.getShieldBalance(secret, tokenAddress);
    } catch (error) {
      throw ErrorHelpers.createError(
        error,
        'Failed to get shield balance',
        ErrorCode.CONTRACT_ERROR
      );
    }
  }

  /**
   * Get contract fee information
   */
  static async getFeeInfo(contract: Contract): Promise<{
    shieldFeePercent: bigint;
    unshieldFeePercent: bigint;
    transferFeePercent: bigint;
    feeDenominator: bigint;
  }> {
    try {
      const [shieldFeePercent, unshieldFeePercent, transferFeePercent, feeDenominator] = await Promise.all([
        contract.shieldFeePercent(),
        contract.unshieldFeePercent(),
        contract.transferFeePercent(),
        contract.FEE_DENOMINATOR()
      ]);

      return {
        shieldFeePercent ,
        unshieldFeePercent ,
        transferFeePercent,
        feeDenominator
      };
    } catch (error) {
      throw ErrorHelpers.createError(
        error,
        'Failed to get fee information',
        ErrorCode.CONTRACT_ERROR
      );
    }
  }

  /**
   * Calculate fee amount
   */
  static calculateFee(
    amount: bigint,
    feePercent: bigint,
    feeDenominator: bigint
  ): bigint {
    return (amount * feePercent) / feeDenominator;
  }

  /**
   * Calculate net amount after fee
   */
  static calculateNetAmount(
    amount: bigint,
    feePercent: bigint,
    feeDenominator: bigint
  ): { netAmount: bigint; fee: bigint } {
    const fee = ContractHelpers.calculateFee(amount, feePercent, feeDenominator);
    const netAmount = amount - fee;
    return { netAmount, fee };
  }

  /**
   * Wait for transaction with timeout and error handling
   */
  static async waitForTransaction(
    txPromise: Promise<any>,
    timeoutMs: number = 60000
  ): Promise<any> {
    try {
      const tx = await txPromise;
      
      // Add timeout to wait
      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Transaction timeout')), timeoutMs)
        )
      ]);

      if (!receipt || receipt.status === 0) {
        throw new Error('Transaction failed');
      }

      return receipt;
    } catch (error) {
      throw ErrorHelpers.createError(
        error,
        'Transaction failed',
        ErrorCode.CONTRACT_ERROR
      );
    }
  }

  /**
   * Execute contract transaction with retry logic
   */
  static async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delayMs: number = 1000
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt === maxRetries) {
          break;
        }

        // Check if error is retryable
        if (ContractHelpers.isNonRetryableError(lastError)) {
          break;
        }

        console.warn(`Attempt ${attempt} failed, retrying in ${delayMs}ms...`, lastError.message);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs *= 2; // Exponential backoff
      }
    }

    throw ErrorHelpers.createError(
      lastError!,
      `Operation failed after ${maxRetries} attempts`,
      ErrorCode.CONTRACT_ERROR
    );
  }

  /**
   * Check if error is non-retryable
   */
  private static isNonRetryableError(error: Error): boolean {
    const nonRetryableMessages = [
      'insufficient funds',
      'nonce too low',
      'replacement transaction underpriced',
      'execution reverted',
      'invalid commitment',
      'shield does not exist',
      'insufficient balance'
    ];

    const message = error.message.toLowerCase();
    return nonRetryableMessages.some(msg => message.includes(msg));
  }

  /**
   * Estimate gas for transaction
   */
  static async estimateGasSafely(
    contract: Contract,
    methodName: string,
    args: any[]
  ): Promise<bigint> {
    try {
      return await contract[methodName].estimateGas(...args);
    } catch (error) {
      console.warn(`Failed to estimate gas for ${methodName}:`, error);
      // Return reasonable default based on operation type
      return ContractHelpers.getDefaultGasLimit(methodName);
    }
  }

  /**
   * Get default gas limits for operations
   */
  private static getDefaultGasLimit(methodName: string): bigint {
    const gasLimits: Record<string, bigint> = {
      shield: BigInt(200000),
      unshield: BigInt(150000),
      transfer: BigInt(200000),
      consolidate: BigInt(300000),
      registerPublicKey: BigInt(50000)
    };

    return gasLimits[methodName] || BigInt(100000);
  }

  /**
   * Check if user has registered public key
   */
  static async hasRegisteredPublicKey(
    contract: Contract,
    userAddress: string
  ): Promise<boolean> {
    try {
      const publicKey = await contract.publicKeys(userAddress);
      return publicKey && publicKey !== '0x';
    } catch (error) {
      console.warn('Failed to check public key registration:', error);
      return false;
    }
  }

  /**
   * Get user nonce from contract
   */
  static async getUserNonce(
    contract: Contract,
    userAddress: string
  ): Promise<number> {
    try {
      const nonce = await contract.userNonces(userAddress);
      return Number(nonce);
    } catch (error) {
      console.warn('Failed to get user nonce:', error);
      return 0;
    }
  }

  /**
   * Batch check shield existence
   */
  static async batchCheckShields(
    contract: Contract,
    commitments: HexString[]
  ): Promise<Array<{
    commitment: HexString;
    exists: boolean;
    spent: boolean;
    amount?: bigint;
    token?: string;
  }>> {
    const results = await Promise.allSettled(
      commitments.map(async (commitment) => {
        const info = await ContractHelpers.getShieldInfoSafely(contract, commitment);
        return {
          commitment,
          exists: info.exists,
          spent: info.spent,
          amount: info.amount,
          token: info.token
        };
      })
    );

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        console.warn(`Failed to check shield ${commitments[index]}:`, result.reason);
        return {
          commitment: commitments[index],
          exists: false,
          spent: true
        };
      }
    });
  }

  /**
   * Validate contract is deployed and accessible
   */
  static async validateContract(contract: Contract): Promise<void> {
    try {
      // Try to call a simple view function to verify contract exists
      await contract.FEE_DENOMINATOR();
    } catch (error) {
      throw ErrorHelpers.createError(
        error,
        'Contract validation failed - contract may not be deployed or accessible',
        ErrorCode.CONTRACT_ERROR
      );
    }
  }

  /**
   * Get contract version (if available)
   */
  static async getContractVersion(contract: Contract): Promise<string | null> {
    try {
      // Try to call version function if it exists
      return await contract.version();
    } catch (error) {
      // Version function doesn't exist in current contract
      return null;
    }
  }
}