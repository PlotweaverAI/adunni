import { EncryptionService } from '@adunni/security';
import { issueToken, createAuthMiddleware, requireRole, requireClientAccess } from '@adunni/security';
import type { AuthenticatedRequest } from '@adunni/security';
import jwt from 'jsonwebtoken';
import express from 'express';
import http from 'http';

const JWT_SECRET = 'test_jwt_secret_for_tests';
const ENCRYPTION_KEY = 'test_encryption_key_for_tests';

describe('EncryptionService', () => {
  const enc = new EncryptionService(ENCRYPTION_KEY);

  test('encrypts and decrypts text correctly', () => {
    const plaintext = '+234 803 123 4567';
    const encrypted = enc.encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    const decrypted = enc.decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  test('produces different ciphertexts for same plaintext (random IV)', () => {
    const text = 'same text';
    const c1 = enc.encrypt(text);
    const c2 = enc.encrypt(text);
    expect(c1).not.toBe(c2);
    expect(enc.decrypt(c1)).toBe(text);
    expect(enc.decrypt(c2)).toBe(text);
  });

  test('encryptField handles null and undefined', () => {
    expect(enc.encryptField(null)).toBeNull();
    expect(enc.encryptField(undefined)).toBeNull();
  });

  test('decryptField returns original value on invalid ciphertext', () => {
    expect(enc.decryptField('not-valid-encrypted-data')).toBe('not-valid-encrypted-data');
  });

  test('hashPii produces consistent hash', () => {
    const h1 = enc.hashPii('+234 803 123 4567');
    const h2 = enc.hashPii('+234 803 123 4567');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  test('generateApiKey produces unique keys', () => {
    const k1 = enc.generateApiKey();
    const k2 = enc.generateApiKey();
    expect(k1).not.toBe(k2);
    expect(k1).toMatch(/^adk_[a-f0-9]+$/);
  });

  test('generateWebhookSecret produces base64url strings', () => {
    const s = enc.generateWebhookSecret();
    expect(s).toHaveLength(64);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('RBAC - JWT and Role Middleware', () => {
  test('issueToken creates valid JWT with role', () => {
    const token = issueToken({ clientId: 'savanna-bank', role: 'admin' }, JWT_SECRET);
    const decoded = jwt.verify(token, JWT_SECRET) as { clientId: string; role: string };
    expect(decoded.clientId).toBe('savanna-bank');
    expect(decoded.role).toBe('admin');
  });

  test('issueToken defaults to client role', () => {
    const token = issueToken({ clientId: 'savanna-bank' }, JWT_SECRET);
    const decoded = jwt.verify(token, JWT_SECRET) as { clientId: string; role: string };
    expect(decoded.role).toBe('client');
  });

  test('authMiddleware rejects missing Authorization header', (done) => {
    const auth = createAuthMiddleware(JWT_SECRET);
    const mockReq = { headers: {} } as express.Request;
    const mockRes = {
      status: (code: number) => ({ json: (body: unknown) => {
        expect(code).toBe(401);
        expect((body as { error: string }).error).toContain('Authorization');
        done();
      } }),
    } as unknown as express.Response;
    auth(mockReq, mockRes, () => done(new Error('Should not call next')));
  });

  test('authMiddleware rejects invalid token', (done) => {
    const auth = createAuthMiddleware(JWT_SECRET);
    const mockReq = {
      headers: { authorization: 'Bearer invalid_token' },
    } as express.Request;
    const mockRes = {
      status: (code: number) => ({ json: (body: unknown) => {
        expect(code).toBe(401);
        expect((body as { error: string }).error).toContain('Invalid');
        done();
      } }),
    } as unknown as express.Response;
    auth(mockReq, mockRes, () => done(new Error('Should not call next')));
  });

  test('authMiddleware accepts valid token and sets auth', (done) => {
    const auth = createAuthMiddleware(JWT_SECRET);
    const token = issueToken({ clientId: 'savanna-bank', role: 'client' }, JWT_SECRET);
    const mockReq = {
      headers: { authorization: `Bearer ${token}` },
    } as AuthenticatedRequest;
    const mockRes = {} as express.Response;
    auth(mockReq, mockRes, () => {
      expect(mockReq.auth?.clientId).toBe('savanna-bank');
      expect(mockReq.auth?.role).toBe('client');
      done();
    });
  });

  test('requireRole allows correct role', (done) => {
    const middleware = requireRole('admin', 'operator');
    const mockReq = { auth: { clientId: 'c1', role: 'admin' } } as AuthenticatedRequest;
    const mockRes = {} as express.Response;
    middleware(mockReq, mockRes, () => done());
  });

  test('requireRole denies incorrect role', (done) => {
    const middleware = requireRole('admin');
    const mockReq = { auth: { clientId: 'c1', role: 'client' } } as AuthenticatedRequest;
    const mockRes = {
      status: (code: number) => ({ json: (body: unknown) => {
        expect(code).toBe(403);
        expect((body as { error: string }).error).toContain('Insufficient');
        done();
      } }),
    } as unknown as express.Response;
    middleware(mockReq, mockRes, () => done(new Error('Should not call next')));
  });

  test('requireClientAccess allows admin to access any client', (done) => {
    const middleware = requireClientAccess('clientId');
    const mockReq = {
      auth: { clientId: 'savanna-bank', role: 'admin' },
      params: { clientId: 'other-bank' },
    } as unknown as AuthenticatedRequest;
    const mockRes = {} as express.Response;
    middleware(mockReq, mockRes, () => done());
  });

  test('requireClientAccess denies client access to other client', (done) => {
    const middleware = requireClientAccess('clientId');
    const mockReq = {
      auth: { clientId: 'savanna-bank', role: 'client' },
      params: { clientId: 'other-bank' },
    } as unknown as AuthenticatedRequest;
    const mockRes = {
      status: (code: number) => ({ json: (body: unknown) => {
        expect(code).toBe(403);
        done();
      } }),
    } as unknown as express.Response;
    middleware(mockReq, mockRes, () => done(new Error('Should not call next')));
  });

  test('requireClientAccess allows client to access own resource', (done) => {
    const middleware = requireClientAccess('clientId');
    const mockReq = {
      auth: { clientId: 'savanna-bank', role: 'client' },
      params: { clientId: 'savanna-bank' },
    } as unknown as AuthenticatedRequest;
    const mockRes = {} as express.Response;
    middleware(mockReq, mockRes, () => done());
  });
});

describe('Rate Limiting', () => {
  test('perClientRateLimit allows requests under limit', (done) => {
    const { perClientRateLimit } = require('@adunni/security');
    const middleware = perClientRateLimit(100, 60_000);
    const mockReq = {
      auth: { clientId: 'c1' },
      ip: '127.0.0.1',
      path: '/v1/sessions',
    } as unknown as express.Request;
    const mockRes = {
      setHeader: () => {},
    } as unknown as express.Response;
    middleware(mockReq, mockRes, () => done());
  });

  test('rateLimitMiddleware skips health checks', (done) => {
    const { rateLimitMiddleware } = require('@adunni/security');
    const middleware = rateLimitMiddleware({ windowMs: 60_000, maxRequests: 1 });
    const mockReq = { ip: '127.0.0.1', path: '/health' } as express.Request;
    const mockRes = {} as express.Response;
    middleware(mockReq, mockRes, () => done());
  });
});

describe('Security Headers', () => {
  test('securityHeaders sets all required headers', (done) => {
    const { securityHeaders } = require('@adunni/security');
    const headers: Record<string, string> = {};
    const mockReq = {} as express.Request;
    const mockRes = {
      setHeader: (key: string, value: string) => { headers[key] = value; },
    } as unknown as express.Response;
    securityHeaders(mockReq, mockRes, () => {
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['Strict-Transport-Security']).toContain('max-age');
      expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
      expect(headers['Permissions-Policy']).toContain('microphone');
      done();
    });
  });
});

describe('Input Validation', () => {
  test('inputValidationMiddleware rejects non-JSON content type on POST', (done) => {
    const { inputValidationMiddleware } = require('@adunni/security');
    const mockReq = {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': '10' },
    } as express.Request;
    const mockRes = {
      status: (code: number) => ({ json: (body: unknown) => {
        expect(code).toBe(415);
        done();
      } }),
    } as unknown as express.Response;
    inputValidationMiddleware(mockReq, mockRes, () => done(new Error('Should not call next')));
  });

  test('inputValidationMiddleware allows JSON content type', (done) => {
    const { inputValidationMiddleware } = require('@adunni/security');
    const mockReq = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '100' },
    } as express.Request;
    const mockRes = {} as express.Response;
    inputValidationMiddleware(mockReq, mockRes, () => done());
  });

  test('inputValidationMiddleware allows GET without content type', (done) => {
    const { inputValidationMiddleware } = require('@adunni/security');
    const mockReq = {
      method: 'GET',
      headers: {},
    } as express.Request;
    const mockRes = {} as express.Response;
    inputValidationMiddleware(mockReq, mockRes, () => done());
  });
});
