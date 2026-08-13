import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export type UserRole = 'admin' | 'operator' | 'client';

export interface JwtPayload {
  clientId: string;
  role: UserRole;
  userId?: string;
  sessionId?: string;
}

export interface AuthenticatedRequest extends Request {
  auth?: JwtPayload;
}

export function createAuthMiddleware(secret: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);
    try {
      const decoded = jwt.verify(token, secret) as JwtPayload;
      req.auth = decoded;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

export function requireClientAccess(paramName: string = 'clientId') {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const targetClientId = req.params[paramName];
    if (req.auth.role === 'admin') {
      return next();
    }
    if (req.auth.role === 'operator' || req.auth.role === 'client') {
      if (req.auth.clientId !== targetClientId) {
        return res.status(403).json({ error: 'Access denied: resource belongs to another client' });
      }
      return next();
    }
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

export function issueToken(
  payload: Omit<JwtPayload, 'role'> & { role?: UserRole },
  secret: string,
  expiresIn: string = '1h'
): string {
  return jwt.sign(
    { ...payload, role: payload.role ?? 'client' },
    secret,
    { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] }
  );
}
