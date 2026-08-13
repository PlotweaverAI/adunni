export { createSecureServer, createSecureWebSocketOptions } from './tls.js';
export type { TlsOptions } from './tls.js';

export { EncryptionService } from './encryption.js';

export {
  createAuthMiddleware,
  requireRole,
  requireClientAccess,
  issueToken,
} from './rbac.js';
export type { UserRole, JwtPayload, AuthenticatedRequest } from './rbac.js';

export { NdprComplianceService, consentMiddleware } from './ndpr.js';
export type { NdprConsent } from './ndpr.js';

export { AuditLogger } from './audit.js';
export type { AuditEvent, AuditEventType } from './audit.js';

export {
  rateLimitMiddleware,
  perClientRateLimit,
  inputValidationMiddleware,
  securityHeaders,
} from './rate-limit.js';
export type { RateLimitConfig } from './rate-limit.js';
