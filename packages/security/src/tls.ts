import https from 'https';
import http from 'http';
import fs from 'fs';
import type { Express } from 'express';

export interface TlsOptions {
  certPath?: string;
  keyPath?: string;
  forceHttps?: boolean;
}

export function createSecureServer(
  app: Express,
  port: number,
  tls?: TlsOptions
): http.Server | https.Server {
  if (tls?.certPath && tls?.keyPath) {
    const cert = fs.readFileSync(tls.certPath);
    const key = fs.readFileSync(tls.keyPath);
    const server = https.createServer({ cert, key }, app);
    server.listen(port, () => {
      console.log(`[server] HTTPS listening on :${port}`);
    });
    return server;
  }

  if (tls?.forceHttps) {
    app.use((req, res, next) => {
      const proto = req.headers['x-forwarded-proto'];
      if (proto === 'http') {
        return res.redirect(301, `https://${req.headers.host}${req.url}`);
      }
      next();
    });
  }

  const server = http.createServer(app);
  server.listen(port, () => {
    console.log(`[server] HTTP listening on :${port}`);
  });
  return server;
}

export function createSecureWebSocketOptions(tls?: TlsOptions): https.ServerOptions {
  if (tls?.certPath && tls?.keyPath) {
    return {
      cert: fs.readFileSync(tls.certPath),
      key: fs.readFileSync(tls.keyPath),
    };
  }
  return {};
}
