import { LaserGunError, ErrorCode } from '../types';

/**
 * Error handling utilities and common error creation patterns
 * Provides consistent error handling across the SDK
 */
export class ErrorHelpers {

  /**
   * Create standardized LaserGun error from unknown error
   */
  static createError(
    error: unknown, 
    baseMessage: string, 
    defaultCode: ErrorCode = ErrorCode.CONTRACT_ERROR
  ): LaserGunError {
    if (error instanceof LaserGunError) {
      return error;
    }
    
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new LaserGunError(`${baseMessage}: ${message}`, defaultCode, error);
  }

  /**
   * Create validation error with context
   */
  static validationError(field: string, value: any, expectedFormat?: string): LaserGunError {
    const expected = expectedFormat ? ` (expected: ${expectedFormat})` : '';
    return new LaserGunError(
      `Invalid ${field}: ${value}${expected}`,
      ErrorCode.VALIDATION_ERROR
    );
  }

  /**
   * Create insufficient balance error
   */
  static insufficientBalanceError(
    required: string, 
    available: string, 
    token?: string
  ): LaserGunError {
    const tokenInfo = token ? ` for token ${token}` : '';
    return new LaserGunError(
      `Insufficient balance${tokenInfo}. Required: ${required}, Available: ${available}`,
      ErrorCode.INSUFFICIENT_BALANCE
    );
  }

  /**
   * Create shield not found error
   */
  static shieldNotFoundError(commitment?: string): LaserGunError {
    const commitmentInfo = commitment ? ` (commitment: ${commitment})` : '';
    return new LaserGunError(
      `Shield does not exist or already spent${commitmentInfo}`,
      ErrorCode.SHIELD_NOT_FOUND
    );
  }

  /**
   * Create network error with chain info
   */
  static networkError(message: string, chainId?: number): LaserGunError {
    const chainInfo = chainId ? ` (chain: ${chainId})` : '';
    return new LaserGunError(
      `Network error${chainInfo}: ${message}`,
      ErrorCode.NETWORK_ERROR
    );
  }

  /**
   * Create storage error with context
   */
  static storageError(operation: string, details?: string): LaserGunError {
    const detailsInfo = details ? `: ${details}` : '';
    return new LaserGunError(
      `Storage operation failed: ${operation}${detailsInfo}`,
      ErrorCode.STORAGE_ERROR
    );
  }

  /**
   * Create initialization error
   */
  static initializationError(component: string, reason?: string): LaserGunError {
    const reasonInfo = reason ? `: ${reason}` : '';
    return new LaserGunError(
      `${component} not properly initialized${reasonInfo}`,
      ErrorCode.INVALID_CONFIG
    );
  }

  /**
   * Create HD derivation error
   */
  static hdDerivationError(path: string, reason?: string): LaserGunError {
    const reasonInfo = reason ? `: ${reason}` : '';
    return new LaserGunError(
      `HD derivation failed for path ${path}${reasonInfo}`,
      ErrorCode.HD_DERIVATION_ERROR
    );
  }

  /**
   * Create crypto error with operation context
   */
  static cryptoError(operation: string, details?: string): LaserGunError {
    const detailsInfo = details ? `: ${details}` : '';
    return new LaserGunError(
      `Crypto operation failed: ${operation}${detailsInfo}`,
      ErrorCode.CRYPTO_ERROR
    );
  }

  /**
   * Create scanner error with block context
   */
  static scannerError(
    message: string, 
    blockNumber?: number, 
    txHash?: string
  ): LaserGunError {
    let context = '';
    if (blockNumber) context += ` (block: ${blockNumber})`;
    if (txHash) context += ` (tx: ${txHash})`;
    
    return new LaserGunError(
      `Scanner error: ${message}${context}`,
      ErrorCode.SCANNER_ERROR
    );
  }

  /**
   * Wrap async operation with standardized error handling
   */
  static async wrapAsyncOperation<T>(
    operation: () => Promise<T>,
    baseMessage: string,
    errorCode: ErrorCode = ErrorCode.CONTRACT_ERROR
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw ErrorHelpers.createError(error, baseMessage, errorCode);
    }
  }

  /**
   * Create error with suggestions for recovery
   */
  static errorWithSuggestions(
    message: string,
    code: ErrorCode,
    suggestions: string[]
  ): LaserGunError {
    const suggestionsText = suggestions.length > 0 
      ? `\n\nSuggestions:\n${suggestions.map(s => `- ${s}`).join('\n')}`
      : '';
    
    return new LaserGunError(`${message}${suggestionsText}`, code);
  }

  /**
   * Check if error is of specific type
   */
  static isErrorType(error: unknown, code: ErrorCode): boolean {
    return error instanceof LaserGunError && error.code === code;
  }

  /**
   * Extract error message safely
   */
  static getErrorMessage(error: unknown): string {
    if (error instanceof LaserGunError) {
      return error.message;
    }
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  /**
   * Create timeout error
   */
  static timeoutError(operation: string, timeoutMs: number): LaserGunError {
    return new LaserGunError(
      `Operation timed out: ${operation} (${timeoutMs}ms)`,
      ErrorCode.NETWORK_ERROR
    );
  }

  /**
   * Create rate limit error
   */
  static rateLimitError(retryAfterMs?: number): LaserGunError {
    const retryInfo = retryAfterMs ? ` Retry after ${retryAfterMs}ms.` : '';
    return new LaserGunError(
      `Rate limit exceeded.${retryInfo}`,
      ErrorCode.NETWORK_ERROR
    );
  }

  /**
   * Create commitment already exists error
   */
  static commitmentExistsError(commitment: string): LaserGunError {
    return new LaserGunError(
      `Commitment already exists: ${commitment}`,
      ErrorCode.COMMITMENT_EXISTS
    );
  }

  /**
   * Aggregate multiple errors into single error
   */
  static aggregateErrors(
    errors: Array<{ error: Error; context?: string }>,
    baseMessage: string
  ): LaserGunError {
    if (errors.length === 0) {
      return new LaserGunError(baseMessage, ErrorCode.CONTRACT_ERROR);
    }
    
    if (errors.length === 1) {
      const { error, context } = errors[0];
      const contextInfo = context ? ` (${context})` : '';
      return ErrorHelpers.createError(error, `${baseMessage}${contextInfo}`);
    }
    
    const errorMessages = errors.map(({ error, context }, index) => {
      const contextInfo = context ? ` (${context})` : '';
      return `${index + 1}. ${ErrorHelpers.getErrorMessage(error)}${contextInfo}`;
    }).join('\n');
    
    return new LaserGunError(
      `${baseMessage}. Multiple errors:\n${errorMessages}`,
      ErrorCode.CONTRACT_ERROR
    );
  }
}