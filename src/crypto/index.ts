/**
 * Crypto module index
 * Re-exports for backward compatibility
 */

export { HDSecretManager, HDOperation, MAX_HD_INDEX } from './HDSecretManager';
export { CryptoService } from './CryptoService';

import { HDSecretManager } from './HDSecretManager';
import  { CryptoService } from './CryptoService';

// Re-export for convenience
export const Crypto = {
  Service: CryptoService,
  HDManager: HDSecretManager
};