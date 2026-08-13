import type { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: Request) => string;
  skipPaths?: string[];
}

export function rateLimitMiddleware(config: RateLimitConfig) {
  const store = new Map<string, RateLimitEntry>();
  const skipPaths = new Set(config.skipPaths ?? ['/health', '/info']);

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetTime) {
        store.delete(key);
      }
    }
  }, config.windowMs);

  return (req: Request, res: Response, next: NextFunction) => {
    if (skipPaths.has(req.path)) return next();

    const key = config.keyGenerator
      ? config.keyGenerator(req)
      : req.ip ?? 'unknown';

    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now > entry.resetTime) {
      store.set(key, { count: 1, resetTime: now + config.windowMs });
      res.setHeader('X-RateLimit-Limit', String(config.maxRequests));
      res.setHeader('X-RateLimit-Remaining', String(config.maxRequests - 1));
      return next();
    }

    entry.count++;
    const remaining = Math.max(0, config.maxRequests - entry.count);

    res.setHeader('X-RateLimit-Limit', String(config.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetTime / 1000)));

    if (entry.count > config.maxRequests) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil((entry.resetTime - now) / 1000),
      });
    }

    next();
  };
}

export function perClientRateLimit(maxRequests: number = 100, windowMs: number = 60_000) {
  return rateLimitMiddleware({
    windowMs,
    maxRequests,
    keyGenerator: (req: Request & { auth?: { clientId: string } }) =>
      req.auth?.clientId ?? req.ip ?? 'anonymous',
    skipPaths: ['/health', '/info'],
  });
}

export function inputValidationMiddleware(req: Request, res: Response, next: NextFunction) {
  const contentType = req.headers['content-type'];
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    if (!contentType?.includes('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
  }

  const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
  if (contentLength > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'Request body too large (max 10MB)' });
  }

  next();
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), geolocation=()');
  next();
}
