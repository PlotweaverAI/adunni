import express from 'express';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import type {
  ClientConfig,
  LanguageCode,
  OrchestratorRequest,
  OrchestratorResponse,
  ConversationContext,
  SessionPhase,
} from '@adunni/shared-types';
import {
  createAuthMiddleware,
  requireRole,
  requireClientAccess,
  issueToken,
  EncryptionService,
  AuditLogger,
  NdprComplianceService,
  rateLimitMiddleware,
  perClientRateLimit,
  inputValidationMiddleware,
  securityHeaders,
  createSecureServer,
  type AuthenticatedRequest,
  type AuditEventType,
} from '@adunni/security';
import { TavusClient } from './tavus.js';
import { StormTtsClient } from './storm-tts.js';

// Translation cache: key = "text|src|tgt" -> translated text
const translationCache = new Map<string, string>();
async function cachedTranslate(text: string, src: string, tgt: string): Promise<string> {
  const key = `${text}|${src}|${tgt}`;
  const cached = translationCache.get(key);
  if (cached) return cached;
  const resp = await fetch(`${ASR_SERVICE_URL}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, source_language: src, target_language: tgt }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Translation failed: ${resp.status}`);
  const result = await resp.json() as { translated_text: string };
  translationCache.set(key, result.translated_text);
  return result.translated_text;
}

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev_jwt_secret_change_in_production';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'dev_encryption_key_change_in_production';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adunni:adunni_dev_pass@localhost:5432/adunni';
const TLS_CERT = process.env.TLS_CERT_PATH;
const TLS_KEY = process.env.TLS_KEY_PATH;
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const DEMO_CLIENT_ID = process.env.DEMO_CLIENT_ID ?? 'savanna-bank';
const TAVUS_API_KEY = process.env.TAVUS_API_KEY ?? '';
const tavus = TAVUS_API_KEY ? new TavusClient(TAVUS_API_KEY) : null;

const STORM_TTS_URL = process.env.STORM_TTS_URL ?? 'http://54.198.152.226:8000';
const STORM_TTS_API_KEY = process.env.STORM_TTS_API_KEY ?? '';
const stormTts = STORM_TTS_API_KEY ? new StormTtsClient(STORM_TTS_API_KEY, STORM_TTS_URL) : null;

const ASR_SERVICE_URL = process.env.ASR_SERVICE_URL ?? 'http://localhost:3001';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3003';
const ACTION_EXECUTOR_URL = process.env.ACTION_EXECUTOR_URL ?? 'http://localhost:3004';
const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL ?? 'http://localhost:3005';
const SESSION_STORE_URL = process.env.SESSION_STORE_URL ?? 'http://localhost:3006';

// Pre-warm translation cache with common AI responses (mock LLM returns these)
const COMMON_AI_RESPONSES = [
  'Done. I checked your account balance.',
  'Done. I checked the transfer status.',
  'I can help with account balance, transfer status, or transfer limits. Bank statements are not available yet. If you need one, I can connect you to a human agent.',
  'I apologize, but I was unable to complete that action: undefined',
];
const PREWARM_LANGS: LanguageCode[] = ['yo', 'ha', 'ig'];

function formatActionSuccessMessage(actionName: string, confirmed = false): string {
  switch (actionName) {
    case 'get_balance':
      return confirmed ? 'Confirmed. I checked your account balance.' : 'Done. I checked your account balance.';
    case 'get_transfer_status':
      return confirmed ? 'Confirmed. I checked the transfer status.' : 'Done. I checked the transfer status.';
    case 'update_transfer_limit':
      return confirmed ? 'Confirmed. Your transfer limit has been updated successfully.' : 'Done. Your transfer limit has been updated successfully.';
    default:
      return confirmed ? 'Confirmed. The action has been completed successfully.' : 'Done. The action has been completed successfully.';
  }
}

function formatActionFailureMessage(errorMessage?: string): string {
  return errorMessage
    ? `I apologize, but I was unable to complete that action: ${errorMessage}`
    : 'I apologize, but I was unable to complete that action.';
}

async function prewarmTranslations() {
  if (!ASR_SERVICE_URL) return;
  for (const text of COMMON_AI_RESPONSES) {
    for (const lang of PREWARM_LANGS) {
      try {
        await cachedTranslate(text, 'en-NG', lang);
      } catch { /* ignore errors during prewarm */ }
    }
  }
  console.log('[gateway] Translation cache pre-warmed');
}
// Fire prewarm in background (don't block startup)
setTimeout(() => { prewarmTranslations().catch(() => {}); }, 5000);

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
const encryption = new EncryptionService(ENCRYPTION_KEY);
const auditLogger = new AuditLogger(pool);
const ndprService = new NdprComplianceService(pool);

const app = express();
app.use(securityHeaders);
app.use(inputValidationMiddleware);

// ── CORS ──
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Id');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
  }
  next();
});

app.use(rateLimitMiddleware({ windowMs: 60_000, maxRequests: 200, skipPaths: ['/health', '/info'] }));
app.use(express.json({ limit: '5mb' }));

const authMiddleware = createAuthMiddleware(JWT_SECRET);

const server = createSecureServer(app, PORT, { certPath: TLS_CERT, keyPath: TLS_KEY, forceHttps: !!(TLS_CERT && TLS_KEY) });
const wss = new WebSocketServer({ server });

app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.1.0' }));

// ── Serve frontend demo at / ──
const FRONTEND_DIR = path.resolve(process.env.FRONTEND_PATH ?? path.join(__dirname, '..', '..', '..'));
const FRONTEND_PATH = path.join(FRONTEND_DIR, 'index.html');
app.get('/', (_req, res) => {
  try {
    if (fs.existsSync(FRONTEND_PATH)) {
      res.sendFile(FRONTEND_PATH);
    } else {
      res.status(404).json({ error: 'Frontend not found' });
    }
  } catch {
    res.status(404).json({ error: 'Frontend not found' });
  }
});

// Serve live.html (standalone live voice agent page)
app.get('/live.html', (_req, res) => {
  try {
    const livePath = path.join(FRONTEND_DIR, 'live.html');
    if (fs.existsSync(livePath)) {
      res.sendFile(livePath);
    } else {
      res.status(404).json({ error: 'live.html not found' });
    }
  } catch {
    res.status(404).json({ error: 'live.html not found' });
  }
});

// ── GET /info — Public endpoint returning demo client config (no auth) ──
app.get('/info', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT client_id, client_name, allowed_languages, default_language, branding FROM clients WHERE client_id = $1',
      [DEMO_CLIENT_ID]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Demo client not found' });
    res.json({
      clientId: rows[0]['client_id'],
      clientName: rows[0]['client_name'],
      allowedLanguages: rows[0]['allowed_languages'],
      defaultLanguage: rows[0]['default_language'],
      branding: rows[0]['branding'],
    });
  } catch (err) {
    console.error('[gateway] info error:', err);
    res.status(500).json({ error: 'Failed to get info' });
  }
});

// ── POST /v1/auth/demo — Issue a demo JWT for the public frontend (no API key required) ──
app.post('/v1/auth/demo', async (req, res) => {
  try {
    const { clientId } = req.body;
    const targetClient = clientId ?? DEMO_CLIENT_ID;

    const { rows } = await pool.query('SELECT client_id FROM clients WHERE client_id = $1', [targetClient]);
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });

    const token = issueToken(
      { clientId: targetClient, role: 'client' },
      JWT_SECRET,
      '24h'
    );
    res.json({ token, clientId: targetClient, role: 'client', expiresIn: '24h' });
  } catch (err) {
    console.error('[gateway] auth/demo error:', err);
    res.status(500).json({ error: 'Failed to issue demo token' });
  }
});

// ── POST /v1/auth/token — Issue a JWT token via API key ──
app.post('/v1/auth/token', async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'apiKey is required' });

    const keyHash = encryption.hashPii(apiKey);
    const { rows } = await pool.query(
      'SELECT client_id, role FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
      [keyHash]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Invalid or revoked API key' });

    await pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1', [keyHash]);

    const token = issueToken(
      { clientId: rows[0]['client_id'], role: rows[0]['role'] },
      JWT_SECRET,
      '24h'
    );
    res.json({ token, clientId: rows[0]['client_id'], role: rows[0]['role'], expiresIn: '24h' });
  } catch (err) {
    console.error('[gateway] auth/token error:', err);
    res.status(500).json({ error: 'Failed to issue token' });
  }
});

// ── POST /v1/auth/keys — Generate a new API key (admin only) ──
app.post('/v1/auth/keys', authMiddleware, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const { clientId, role = 'client' } = req.body;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    const plainKey = encryption.generateApiKey();
    const keyHash = encryption.hashPii(plainKey);
    const keyPrefix = plainKey.slice(0, 8);

    await pool.query(
      'INSERT INTO api_keys (client_id, key_hash, key_prefix, role, created_by) VALUES ($1, $2, $3, $4, $5)',
      [clientId, keyHash, keyPrefix, role, req.auth!.clientId]
    );
    await auditLogger.logFromRequest(req, 'auth_failure', { action: 'api_key_created', clientId, role });

    res.status(201).json({ apiKey: plainKey, keyPrefix, clientId, role });
  } catch (err) {
    console.error('[gateway] auth/keys error:', err);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// ── GET /v1/sessions/:sessionId — Get session metadata ──
app.get('/v1/sessions/:sessionId', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    const resp = await fetch(`${SESSION_STORE_URL}/sessions/${req.params.sessionId}`);
    if (resp.status === 404) return res.status(404).json({ error: 'Session not found' });
    if (!resp.ok) throw new Error(`session-store returned ${resp.status}`);
    const session = await resp.json() as { clientId: string; [key: string]: unknown };

    if (session.clientId !== req.auth!.clientId && req.auth!.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied: session belongs to another client' });
    }
    res.json(session);
  } catch (err) {
    console.error('[gateway] getSession error:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// ── GET /v1/clients — List all clients ──
app.get('/v1/clients', authMiddleware, requireRole('admin'), async (_req: AuthenticatedRequest, res) => {
  try {
    const resp = await fetch(`${CONFIG_SERVICE_URL}/clients`);
    if (!resp.ok) throw new Error(`config-service returned ${resp.status}`);
    res.json(await resp.json());
  } catch (err) {
    console.error('[gateway] listClients error:', err);
    res.status(500).json({ error: 'Failed to list clients' });
  }
});

// ── PATCH /v1/actions/:actionId — Update action status ──
app.patch('/v1/actions/:actionId', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    const resp = await fetch(`${SESSION_STORE_URL}/actions/${req.params.actionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    if (!resp.ok) throw new Error(`session-store returned ${resp.status}`);
    res.json(await resp.json());
  } catch (err) {
    console.error('[gateway] updateAction error:', err);
    res.status(500).json({ error: 'Failed to update action' });
  }
});

// ── POST /v1/sessions/:sessionId/actions/:actionId/confirm — Confirm or deny a pending action ──
app.post('/v1/sessions/:sessionId/actions/:actionId/confirm', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    const { confirmed } = req.body;
    const resp = await fetch(`${ACTION_EXECUTOR_URL}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: req.params.actionId, confirmed }),
    });
    if (!resp.ok) throw new Error(`action-executor returned ${resp.status}`);
    const result = await resp.json();
    await auditLogger.logFromRequest(req, 'action_confirm', {
      sessionId: req.params.sessionId,
      actionId: req.params.actionId,
      confirmed,
    });
    res.json(result);
  } catch (err) {
    console.error('[gateway] confirmAction error:', err);
    res.status(500).json({ error: 'Failed to confirm action' });
  }
});

// ── POST /v1/sessions — Start a new voice session ──
app.post('/v1/sessions', authMiddleware, perClientRateLimit(50), async (req: AuthenticatedRequest, res) => {
  try {
    const { callerId, callerPhone, preferredLanguage, metadata, ndprConsent } = req.body;
    if (!callerId) return res.status(400).json({ error: 'callerId is required' });
    if (ndprConsent === undefined) return res.status(400).json({ error: 'ndprConsent is required (true/false)' });

    const encryptedPhone = callerPhone ? encryption.encryptField(callerPhone) : null;
    const phoneHash = callerPhone ? encryption.hashPii(callerPhone) : null;

    const sessionResp = await fetch(`${SESSION_STORE_URL}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: req.auth!.clientId,
        callerId,
        callerPhone: encryptedPhone,
        callerPhoneHash: phoneHash,
        preferredLanguage,
        metadata,
      }),
    });

    if (!sessionResp.ok) throw new Error(`session-store returned ${sessionResp.status}`);
    const session = await sessionResp.json() as { id: string; [key: string]: unknown };

    if (ndprConsent) {
      await ndprService.recordConsent(session.id, callerId, true);
    }

    await auditLogger.logFromRequest(req, 'session_start', { sessionId: session.id, callerId });

    const streamToken = issueToken(
      { clientId: req.auth!.clientId, sessionId: session.id, role: 'client' },
      JWT_SECRET,
      '1h'
    );

    res.status(201).json({
      ...session,
      streamUrl: `/v1/sessions/${session.id}/stream`,
      streamToken,
    });
  } catch (err) {
    console.error('[gateway] createSession error:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// ── GET /v1/sessions/:id/transcript — Retrieve transcript + actions ──
app.get('/v1/sessions/:sessionId/transcript', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    const resp = await fetch(`${SESSION_STORE_URL}/sessions/${req.params.sessionId}/transcript`);
    if (resp.status === 404) return res.status(404).json({ error: 'Session not found' });
    if (!resp.ok) throw new Error(`session-store returned ${resp.status}`);
    const transcript = await resp.json() as { session: { clientId: string }; [key: string]: unknown };

    if (transcript.session.clientId !== req.auth!.clientId && req.auth!.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied: session belongs to another client' });
    }
    await auditLogger.logFromRequest(req, 'transcript_read', { sessionId: req.params.sessionId });
    res.json(transcript);
  } catch (err) {
    console.error('[gateway] getTranscript error:', err);
    res.status(500).json({ error: 'Failed to get transcript' });
  }
});

// ── GET /v1/sessions/:id/summary ──
app.get('/v1/sessions/:sessionId/summary', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    const resp = await fetch(`${SESSION_STORE_URL}/sessions/${req.params.sessionId}/summary`);
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to get summary' });
    res.json(await resp.json());
  } catch (err) {
    console.error('[gateway] getSummary error:', err);
    res.status(500).json({ error: 'Failed to get summary' });
  }
});

// ── POST /v1/clients/:clientId/config — Set/update client config ──
app.post('/v1/clients/:clientId/config', authMiddleware, requireClientAccess(), async (req: AuthenticatedRequest, res) => {
  try {
    const resp = await fetch(`${CONFIG_SERVICE_URL}/clients/${req.params.clientId}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    if (!resp.ok) throw new Error(`config-service returned ${resp.status}`);
    res.status(201).json(await resp.json());
  } catch (err) {
    console.error('[gateway] updateConfig error:', err);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// ── GET /v1/clients/:clientId/config ──
app.get('/v1/clients/:clientId/config', authMiddleware, requireClientAccess(), async (req: AuthenticatedRequest, res) => {
  try {
    const resp = await fetch(`${CONFIG_SERVICE_URL}/clients/${req.params.clientId}/config`);
    if (resp.status === 404) return res.status(404).json({ error: 'Client not found' });
    if (!resp.ok) throw new Error(`config-service returned ${resp.status}`);
    res.json(await resp.json());
  } catch (err) {
    console.error('[gateway] getConfig error:', err);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

// ── POST /v1/webhooks/subscribe ──
app.post('/v1/webhooks/subscribe', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    const { url, events } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const configResp = await fetch(`${CONFIG_SERVICE_URL}/clients/${req.auth!.clientId}/config`);
    if (!configResp.ok) return res.status(404).json({ error: 'Client not found' });
    const config = await configResp.json() as Record<string, unknown>;

    const webhookSecret = encryption.generateWebhookSecret();
    await fetch(`${CONFIG_SERVICE_URL}/clients/${req.auth!.clientId}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...config, webhookUrl: url, webhookSecret }),
    });

    await auditLogger.logFromRequest(req, 'webhook_subscribe', { url });
    res.status(201).json({ status: 'subscribed', url, events: events ?? ['turn.complete', 'action.executed', 'session.ended'] });
  } catch (err) {
    console.error('[gateway] subscribe error:', err);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// ── NDPR: POST /v1/callers/:callerId/erasure — Right to erasure ──
app.post('/v1/callers/:callerId/erasure', authMiddleware, requireRole('admin', 'operator'), async (req: AuthenticatedRequest, res) => {
  try {
    const result = await ndprService.rightToErasure(req.params.callerId, req.auth!.clientId);
    await auditLogger.logFromRequest(req, 'ndpr_erasure_request', { callerId: req.params.callerId, ...result });
    res.json({ status: 'erased', ...result });
  } catch (err) {
    console.error('[gateway] erasure error:', err);
    res.status(500).json({ error: 'Failed to process erasure request' });
  }
});

// ── NDPR: GET /v1/callers/:callerId/export — Data portability ──
app.get('/v1/callers/:callerId/export', authMiddleware, requireRole('admin', 'operator'), async (req: AuthenticatedRequest, res) => {
  try {
    const data = await ndprService.dataPortability(req.params.callerId, req.auth!.clientId);
    await auditLogger.logFromRequest(req, 'data_export', { callerId: req.params.callerId });
    res.json(data);
  } catch (err) {
    console.error('[gateway] export error:', err);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// ── POST /v1/video/conversation — Create a Tavus CVI video conversation (echo mode) ──
app.post('/v1/video/conversation', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    if (!tavus) {
      return res.status(503).json({ error: 'Video interface not configured. Set TAVUS_API_KEY.' });
    }

    const { palId, sessionId } = req.body;
    const conversationName = sessionId ? `Adunni Session ${sessionId.slice(0, 8)}` : 'Adunni Session';

    let echoPalId = palId;
    if (!echoPalId) {
      const pal = await tavus.getOrCreateEchoPal('Adunni Echo');
      echoPalId = pal.pal_id;
    }

    const conversation = await tavus.createConversation(echoPalId, conversationName);

    await auditLogger.logFromRequest(req, 'session_start', {
      sessionId: sessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) ? sessionId : undefined,
      videoConversationId: conversation.conversation_id,
      action: 'video_conversation_created',
    });

    res.status(201).json({
      conversationId: conversation.conversation_id,
      conversationUrl: conversation.conversation_url,
      status: conversation.status,
      palId: echoPalId,
    });
  } catch (err) {
    const msg = (err as Error).message;
    console.error('[gateway] createVideoConversation error:', msg);
    const isTavusError = msg.includes('Tavus');
    const status = isTavusError ? 503 : 500;
    res.status(status).json({ error: 'Failed to create video conversation', detail: msg });
  }
});

// ── POST /v1/video/conversation/:conversationId/end — End a Tavus video conversation ──
app.post('/v1/video/conversation/:conversationId/end', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    if (!tavus) {
      return res.status(503).json({ error: 'Video interface not configured.' });
    }

    await tavus.endConversation(req.params.conversationId);

    await auditLogger.logFromRequest(req, 'session_end', {
      videoConversationId: req.params.conversationId,
      action: 'video_conversation_ended',
    });

    res.json({ status: 'ended', conversationId: req.params.conversationId });
  } catch (err) {
    console.error('[gateway] endVideoConversation error:', err);
    res.status(500).json({ error: 'Failed to end video conversation' });
  }
});

// ── POST /v1/video/echo — Send an echo message to a Tavus video conversation (text → face speaks) ──
app.post('/v1/video/echo', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    if (!tavus) {
      return res.status(503).json({ error: 'Video interface not configured.' });
    }

    const { conversationUrl, conversationId, text, audio, sampleRate, inferenceId, done } = req.body;
    if (!conversationUrl || !conversationId) {
      return res.status(400).json({ error: 'conversationUrl and conversationId are required' });
    }
    if (!text && !audio) {
      return res.status(400).json({ error: 'Either text or audio is required' });
    }

    await tavus.sendEchoMessage(conversationUrl, conversationId, text, {
      audio,
      sampleRate,
      inferenceId,
      done,
    });

    res.json({ status: 'echo_sent' });
  } catch (err) {
    console.error('[gateway] videoEcho error:', err);
    res.status(500).json({ error: 'Failed to send echo message', detail: (err as Error).message });
  }
});

// ── GET /v1/video/status — Check if video interface is available ──
app.get('/v1/video/status', (_req, res) => {
  res.json({
    available: !!tavus,
    echoMode: true,
    provider: 'tavus',
  });
});

// ── GET /v1/tts/status — Check if TTS is available ──
app.get('/v1/tts/status', (_req, res) => {
  res.json({
    available: !!stormTts,
    provider: stormTts ? 'storm-tts' : 'browser-tts',
    languages: ['yo', 'ha', 'ig', 'pcm', 'en-NG'],
  });
});

// ── Admin: GET /v1/audit/events — Query audit log ──
app.get('/v1/audit/events', authMiddleware, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const events = await auditLogger.query({
      clientId: req.query['clientId'] as string | undefined,
      sessionId: req.query['sessionId'] as string | undefined,
      eventType: req.query['eventType'] as AuditEventType | undefined,
      limit: parseInt(req.query['limit'] as string ?? '100', 10),
    });
    res.json(events);
  } catch (err) {
    console.error('[gateway] audit query error:', err);
    res.status(500).json({ error: 'Failed to query audit log' });
  }
});

// ── WebSocket: /v1/sessions/:sessionId/stream — Real-time bidirectional audio ──
wss.on('connection', async (ws: WebSocket, req) => {
  const urlPath = req.url ?? '';
  const match = urlPath.match(/\/v1\/sessions\/([^/]+)\/stream/);
  if (!match) {
    ws.close(1008, 'Invalid path');
    return;
  }
  const sessionId = match[1];

  const token = new URL(urlPath, 'http://localhost').searchParams.get('token');
  if (!token) {
    ws.close(1008, 'Missing token');
    return;
  }

  let decoded: { sessionId: string; clientId: string };
  try {
    decoded = jwt.verify(token, JWT_SECRET) as { sessionId: string; clientId: string };
  } catch {
    ws.close(1008, 'Invalid token');
    return;
  }

  if (decoded.sessionId !== sessionId) {
    ws.close(1008, 'Token does not match session');
    return;
  }

  const clientId = decoded.clientId;
  console.log(`[gateway] WebSocket connected: session=${sessionId} client=${clientId}`);

  let turnIndex = 0;
  let audioBuffer: Buffer[] = [];
  let config: ClientConfig | null = null;
  let sessionActive = true;
  let setupDone = false;
  // Server-side VAD removed — client does VAD, server just buffers and transcribes
  let videoConversation: { conversationId: string; conversationUrl: string } | null = null;
  let partialTranscribeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPartialText = '';
  let detectedLanguage: LanguageCode | null = null;

  // Register message/close handlers BEFORE async setup so early messages aren't lost
  ws.on('message', async (data: Buffer) => {
    if (!sessionActive) return;
    // Wait for setup to complete before processing messages
    while (!setupDone && sessionActive) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!sessionActive) return;

    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'audio') {
        // Real audio chunk from browser microphone
        const audioChunk = msg.audioBase64 ? Buffer.from(msg.audioBase64, 'base64') : Buffer.from(msg.audio, 'base64');
        audioBuffer.push(audioChunk);
        const encoding = msg.encoding || 'webm';

        // Skip server-side VAD for non-final chunks — it's too slow on CPU
        // and the client already does VAD. Just buffer and wait for isFinal.
        // This avoids overwhelming the CPU ASR engine with competing requests.

        // ── Streaming: send partial transcripts (debounced) ──
        // Partial transcription every 5 chunks (~500ms of audio)
        // for faster real-time feedback
        if (!msg.isFinal && audioBuffer.length > 0 && audioBuffer.length % 5 === 0) {
          if (partialTranscribeTimer) clearTimeout(partialTranscribeTimer);
          partialTranscribeTimer = setTimeout(async () => {
            partialTranscribeTimer = null;
            if (audioBuffer.length === 0 || !sessionActive) return;
            try {
              const partialAudio = Buffer.concat(audioBuffer);
              const partialResp = await fetch(`${ASR_SERVICE_URL}/transcribe/partial`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  audio_base64: partialAudio.toString('base64'),
                  encoding: encoding,
                  language: detectedLanguage,
                }),
                signal: AbortSignal.timeout(60000),
              });
              if (partialResp.ok) {
                const partialResult = await partialResp.json() as { text: string; language: LanguageCode; confidence: number; is_partial: boolean };
                if (partialResult.text && partialResult.text.trim() && partialResult.text !== lastPartialText) {
                  lastPartialText = partialResult.text;
                  if (!detectedLanguage && partialResult.language) {
                    detectedLanguage = partialResult.language;
                  }
                  ws.send(JSON.stringify({
                    type: 'transcript',
                    turn: {
                      speaker: 'user',
                      language: partialResult.language,
                      text: partialResult.text,
                      confidence: partialResult.confidence,
                      isPartial: true,
                    },
                  }));
                }
              }
            } catch {
              // Partial transcription failed — non-critical
            }
          }, 200);
        }

        // If marked as final, transcribe the full buffer via the ASR engine
        if (msg.isFinal) {
          if (partialTranscribeTimer) {
            clearTimeout(partialTranscribeTimer);
            partialTranscribeTimer = null;
          }

          if (audioBuffer.length > 0) {
            const combined = Buffer.concat(audioBuffer);
            audioBuffer = [];
            lastPartialText = '';

            console.log(`[gateway] Final audio received: ${combined.length} bytes, encoding=${encoding}, chunks=${audioBuffer.length}`);

            if (combined.length < 200) {
              console.warn('[gateway] Audio too small (' + combined.length + ' bytes), skipping ASR');
              ws.send(JSON.stringify({ type: 'error', message: 'Audio too short. Please hold the mic button longer.' }));
            } else {
              ws.send(JSON.stringify({ type: 'transcribing' }));

              try {
                const asrEngineResp = await fetch(`${ASR_SERVICE_URL}/transcribe`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    audio_base64: combined.toString('base64'),
                    encoding: encoding,
                    language: detectedLanguage || msg.language || null,
                  }),
                  signal: AbortSignal.timeout(120000),
                });

                if (asrEngineResp.ok) {
                  const asrResult = await asrEngineResp.json() as { text: string; language: LanguageCode; confidence: number };
                  console.log(`[gateway] ASR result: text="${asrResult.text?.substring(0, 80)}" lang=${asrResult.language} conf=${asrResult.confidence}`);
                  if (asrResult.text && asrResult.text.trim()) {
                    detectedLanguage = asrResult.language;
                    await processUserUtteranceWithLanguage(
                      asrResult.text,
                      asrResult.language,
                      asrResult.confidence,
                      sessionId,
                      clientId,
                      config,
                      ws,
                      turnIndex,
                      videoConversation
                    );
                    turnIndex += 2;
                  }
                } else {
                  const asrErrorBody = await asrEngineResp.text();
                  console.error('[gateway] ASR engine error:', asrEngineResp.status, asrErrorBody.substring(0, 300));
                  ws.send(JSON.stringify({ type: 'error', message: 'Speech recognition failed' }));
                }
              } catch (asrErr) {
                console.error('[gateway] ASR engine error:', asrErr);
                ws.send(JSON.stringify({ type: 'error', message: 'Speech recognition unavailable' }));
              }
            }
          } else {
            audioBuffer = [];
          }
        }
      } else if (msg.type === 'text') {
        await processUserUtterance(msg.text, sessionId, clientId, config, ws, turnIndex, videoConversation);
        turnIndex += 2;
      } else if (msg.type === 'video') {
        videoConversation = {
          conversationId: msg.conversationId,
          conversationUrl: msg.conversationUrl,
        };
        ws.send(JSON.stringify({ type: 'video.ready', conversationId: msg.conversationId }));
      } else if (msg.type === 'end') {
        if (videoConversation && tavus) {
          try { await tavus.endConversation(videoConversation.conversationId); } catch (e) { console.error('[gateway] video end error:', e); }
        }
        await endSession(sessionId, clientId, ws);
        sessionActive = false;
      }
    } catch (err) {
      console.error('[gateway] ws message error:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Processing error' }));
    }
  });

  ws.on('close', async () => {
    if (videoConversation && tavus) {
      try { await tavus.endConversation(videoConversation.conversationId); } catch (e) { console.error('[gateway] video end on close error:', e); }
    }
    if (sessionActive) {
      await endSession(sessionId, clientId, ws);
      sessionActive = false;
    }
    console.log(`[gateway] WebSocket disconnected: session=${sessionId}`);
  });

  // Async setup (runs after handlers are registered)
  try {
    await fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/phase`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'active' as SessionPhase }),
    });

    const configResp = await fetch(`${CONFIG_SERVICE_URL}/clients/${clientId}/config`);
    if (configResp.ok) {
      config = await configResp.json() as ClientConfig;
    }

    // Load recent conversation history from previous sessions for cross-session memory
    // This lets Adunni remember past conversations with the same client
    try {
      const histResp = await fetch(`${SESSION_STORE_URL}/clients/${clientId}/recent-turns?limit=10`);
      if (histResp.ok) {
        const histData = await histResp.json() as Array<{ speaker: string; text: string; language: string }>;
        if (histData && histData.length > 0) {
          // Store as initial context for this session
          (ws as WebSocket & { priorHistory?: Array<{ speaker: string; text: string; language: string }> }).priorHistory = histData;
          console.log(`[gateway] Loaded ${histData.length} prior turns for cross-session memory`);
        }
      }
    } catch (histErr) {
      console.warn('[gateway] Could not load prior history:', histErr instanceof Error ? histErr.message : histErr);
    }
  } catch (err) {
    console.error('[gateway] setup error:', err);
  }
  setupDone = true;

  // Send a greeting so the user knows the call is active and can start speaking
  const greeting = config
    ? `Hello! I'm ${config.voicePersona.name}. How are you doing today? You can speak to me in English, Yoruba, Igbo, Hausa, or Pidgin.`
    : "Hello! I'm Adunni. How are you doing today? You can speak to me in English, Yoruba, Igbo, Hausa, or Pidgin.";

  ws.send(JSON.stringify({
    type: 'transcript',
    turn: { speaker: 'ai', language: 'en-NG', text: greeting, confidence: 1.0 },
  }));

  // Generate TTS for the greeting — always send to frontend (it handles Tavus echo)
  if (config && stormTts) {
    try {
      const ttsResult = await stormTts.generate(greeting, 'en-NG');
      ws.send(JSON.stringify({
        type: 'audio',
        audioBase64: ttsResult.audio.toString('base64'),
        format: ttsResult.format,
        sampleRate: ttsResult.sampleRate,
        language: 'en-NG',
      }));
    } catch (err) {
      console.error('[gateway] greeting TTS error:', err instanceof Error ? err.message : err);
    }
  }

  ws.send(JSON.stringify({ type: 'turn.complete', turnIndex: 0 }));
});

async function processUserUtterance(
  text: string,
  sessionId: string,
  clientId: string,
  config: ClientConfig | null,
  ws: WebSocket,
  currentTurnIndex: number,
  videoConversation: { conversationId: string; conversationUrl: string } | null = null
) {
  const asrResp = await fetch(`${ASR_SERVICE_URL}/detect-language`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const asrResult = await asrResp.json() as { language: LanguageCode; confidence: number };

  return processUserUtteranceWithLanguage(
    text, asrResult.language, asrResult.confidence,
    sessionId, clientId, config, ws, currentTurnIndex, videoConversation
  );
}

async function processUserUtteranceWithLanguage(
  text: string,
  language: LanguageCode,
  languageConfidence: number,
  sessionId: string,
  clientId: string,
  config: ClientConfig | null,
  ws: WebSocket,
  currentTurnIndex: number,
  _videoConversation: { conversationId: string; conversationUrl: string } | null = null
) {
  const startTime = Date.now();

  // ── Translation step: translate user utterance to config.translationLanguage ──
  const targetLang = config?.translationLanguage ?? 'en-NG';
  let translatedText = text;

  // Skip translation for Pidgin <-> English (mutually intelligible)
  const needsTranslation = language !== targetLang &&
    !((language === 'pcm' && targetLang === 'en-NG') || (language === 'en-NG' && targetLang === 'pcm'));

  // Send user transcript immediately for instant feedback (before translation)
  ws.send(JSON.stringify({
    type: 'transcript',
    turn: { speaker: 'user', language, text, confidence: languageConfidence },
  }));

  // Send "thinking" status so frontend shows immediate feedback
  ws.send(JSON.stringify({ type: 'thinking' }));

  // Fire-and-forget session store (don't block on DB)
  fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId, turnIndex: currentTurnIndex, speaker: 'user',
      language, text, status: 'complete', confidence: languageConfidence,
      latencyMs: Date.now() - startTime,
    }),
  }).catch(() => {});

  // Skip user translation for orchestrator - send original text directly
  // The mock LLM handles native language keywords. Translation is only for display.
  translatedText = text;

  // Fire-and-forget user translation for display only
  if (needsTranslation) {
    cachedTranslate(text, language, targetLang).then(t => {
      ws.send(JSON.stringify({
        type: 'transcript',
        turn: { speaker: 'user', language, text, confidence: languageConfidence, englishTranslation: t },
      }));
    }).catch(err => console.error('[gateway] translation error (user):', err));
  } else if (language === 'pcm' && targetLang === 'en-NG') {
    // Pidgin uses text as-is
  }

  // Get context — use short timeout to avoid blocking if session store is slow
  let context: ConversationContext;
  try {
    const ctxResp = await fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/context`, {
      signal: AbortSignal.timeout(3000),
    });
    context = await ctxResp.json() as ConversationContext;
  } catch {
    // Context fetch failed — continue with empty context (don't block the response)
    console.warn('[gateway] Context fetch failed, continuing with empty context');
    context = {
      sessionId,
      turns: [],
      referencedEntities: {},
      lastLanguage: language,
      dialogueState: { awaitingConfirmation: false, slots: {}, escalationActive: false },
    };
  }

  // Merge prior conversation history (cross-session memory) if available
  const wsWithHistory = ws as WebSocket & { priorHistory?: Array<{ speaker: string; text: string; language: string }> };
  if (wsWithHistory.priorHistory && wsWithHistory.priorHistory.length > 0 && context.turns.length === 0) {
    // Only inject prior history at the start of a new session (when no turns yet)
    context.turns = wsWithHistory.priorHistory.map((t, i) => ({
      id: `prior-${i}`,
      sessionId,
      turnIndex: i - wsWithHistory.priorHistory!.length,
      speaker: t.speaker as 'user' | 'ai',
      language: t.language as LanguageCode,
      text: t.text,
      status: 'complete' as const,
      confidence: 1.0,
      createdAt: new Date(),
    }));
    // Clear after first use so it doesn't get injected again
    wsWithHistory.priorHistory = undefined;
    console.log(`[gateway] Injected ${context.turns.length} prior turns into context`);
  }

  const orchRequest: OrchestratorRequest = {
    sessionId,
    clientId,
    config: config!,
    context,
    userUtterance: translatedText,
    detectedLanguage: language,
    languageConfidence,
  };

  const orchResp = await fetch(`${ORCHESTRATOR_URL}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(orchRequest),
  });

  if (!orchResp.ok) {
    const orchErrBody = await orchResp.text();
    console.error('[gateway] Orchestrator error:', orchResp.status, orchErrBody.substring(0, 300));
    ws.send(JSON.stringify({ type: 'error', message: 'AI processing failed' }));
    ws.send(JSON.stringify({ type: 'turn.complete', turnIndex: currentTurnIndex + 1 }));
    return;
  }

  const orchResult = await orchResp.json() as OrchestratorResponse;
  const decision = orchResult.decision;

  if (!decision) {
    console.error('[gateway] Orchestrator returned no decision:', JSON.stringify(orchResult).substring(0, 300));
    ws.send(JSON.stringify({ type: 'error', message: 'AI returned no decision' }));
    ws.send(JSON.stringify({ type: 'turn.complete', turnIndex: currentTurnIndex + 1 }));
    return;
  }

  console.log(`[gateway] Orchestrator decision: type=${decision.type}`);

  let aiText = '';
  let actionId: string | undefined;

  if (decision.type === 'respond') {
    aiText = decision.text;
  } else if (decision.type === 'action') {
    if (decision.requiresConfirmation) {
      aiText = decision.confirmationPrompt;
      const actionResp = await fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          turnId: null,
          intentName: decision.intentName,
          actionName: decision.actionName,
          parameters: decision.parameters,
          status: 'pending',
        }),
      });
      const action = await actionResp.json() as { id: string };
      actionId = action.id;
    } else {
      const actionResp = await fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          turnId: null,
          intentName: decision.intentName,
          actionName: decision.actionName,
          parameters: decision.parameters,
          status: 'confirmed',
        }),
      });
      const action = await actionResp.json() as { id: string };
      actionId = action.id;

      const execResp = await fetch(`${ACTION_EXECUTOR_URL}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionId: action.id,
          sessionId,
          clientId,
          intentName: decision.intentName,
          actionName: decision.actionName,
          parameters: decision.parameters,
          webhookUrl: config!.webhookUrl ?? '',
          webhookSecret: config!.webhookSecret ?? '',
        }),
      });
      const execResult = await execResp.json() as { status: string; errorMessage?: string };
      aiText = execResult.status === 'executed'
        ? formatActionSuccessMessage(decision.actionName)
        : formatActionFailureMessage(execResult.errorMessage);
    }
  } else if (decision.type === 'confirm_action') {
    if (decision.confirmed) {
      const action = context.pendingAction;
      if (action) {
        const execResp = await fetch(`${ACTION_EXECUTOR_URL}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actionId: action.id,
            sessionId,
            clientId,
            intentName: action.intentName,
            actionName: action.actionName,
            parameters: action.parameters,
            webhookUrl: config!.webhookUrl ?? '',
            webhookSecret: config!.webhookSecret ?? '',
          }),
        });
        const execResult = await execResp.json() as { status: string; errorMessage?: string };
        aiText = execResult.status === 'executed'
          ? formatActionSuccessMessage(action.actionName, true)
          : formatActionFailureMessage(execResult.errorMessage);
      }
    } else {
      aiText = 'No problem. I have cancelled the action. Is there anything else I can help with?';
    }
  } else if (decision.type === 'escalate') {
    aiText = decision.message;
    await fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/phase`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'escalated' as SessionPhase }),
    });
  } else if (decision.type === 'clarify') {
    aiText = decision.prompt;
  }

  // AI always responds in the user's detected language
  const aiLanguage = language;

  // ── Translate AI response back to user's language if different ──
  // With a real LLM (Gemini), the AI already responds in the user's language natively,
  // so we skip NLLB translation. Only translate when using the mock LLM (English-only).
  // Skip translation for Pidgin <-> English (mutually intelligible)
  const usingRealLlm = !!process.env.GEMINI_API_KEY;
  const needsAiTranslation = !usingRealLlm && language !== targetLang && aiText &&
    !((language === 'pcm' && targetLang === 'en-NG') || (language === 'en-NG' && targetLang === 'pcm'));

  let aiTextTranslated = aiText;
  if (needsAiTranslation) {
    try {
      aiTextTranslated = await cachedTranslate(aiText, targetLang, language);
    } catch (err) {
      console.error('[gateway] translation error (AI):', err);
    }
  } else if (language === 'pcm' && targetLang === 'en-NG') {
    aiTextTranslated = aiText; // Pidgin uses English text as-is
  }

  // Fire-and-forget session store (don't block on DB)
  fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId, turnIndex: currentTurnIndex + 1, speaker: 'ai',
      language: aiLanguage, text: aiTextTranslated, status: 'complete',
      confidence: orchResult.confidence, latencyMs: Date.now() - startTime, actionId,
    }),
  }).catch(() => {});

  ws.send(JSON.stringify({
    type: 'transcript',
    turn: { speaker: 'ai', language: aiLanguage, text: aiTextTranslated, confidence: orchResult.confidence, englishTranslation: needsAiTranslation ? aiText : undefined },
  }));

  // ── TTS: synthesize AI response as real audio (streaming sentence-by-sentence) ──
  // STORM TTS generates Nigerian female voice audio (Morenike/Amina).
  // We stream sentence-by-sentence so the first sentence plays while later ones are still generating.
  // Audio is ALWAYS sent to the frontend via WebSocket. The frontend then:
  //   - Plays it through the speakers (audio playback)
  //   - Forwards it to Tavus via Daily sendAppMessage for lip-sync (client-side)
  // This is the correct Tavus API pattern — echo messages go through Daily's data channel,
  // not through server-side WebSocket connections to the Daily room URL.
  if (config && stormTts) {
    try {
      let chunkIndex = 0;
      await stormTts.generateStream(aiTextTranslated, aiLanguage, (chunkAudio, idx) => {
        const chunkBase64 = chunkAudio.toString('base64');
        const isLast = idx === -1;

        // Always send audio to frontend — it handles both playback AND Tavus echo
        ws.send(JSON.stringify({
          type: 'audio',
          audioBase64: chunkBase64,
          format: 'wav' as const,
          sampleRate: 24000,
          chunkIndex: chunkIndex++,
          isLast: isLast,
          language: aiLanguage,
        }));
      });

      // Send end marker so frontend knows the audio stream is complete
      ws.send(JSON.stringify({ type: 'audio', audioBase64: '', format: 'wav', sampleRate: 24000, isLast: true, language: aiLanguage }));
    } catch (err) {
      console.error('[gateway] STORM TTS error:', err instanceof Error ? err.message : err);
      // STORM TTS failed — send text to frontend so it can use browser SpeechSynthesis
      // and also send text echo to Tavus for lip-sync
      ws.send(JSON.stringify({
        type: 'audio',
        audioBase64: '',
        format: 'wav',
        sampleRate: 24000,
        isLast: true,
        language: aiLanguage,
        textFallback: aiTextTranslated,
      }));
    }
  } else {
    // No STORM TTS configured — send text to frontend for browser SpeechSynthesis
    // The frontend will also send it as text echo to Tavus for lip-sync
    ws.send(JSON.stringify({
      type: 'audio',
      audioBase64: '',
      format: 'wav',
      sampleRate: 24000,
      isLast: true,
      language: aiLanguage,
      textFallback: aiTextTranslated,
    }));
  }

  ws.send(JSON.stringify({ type: 'turn.complete', turnIndex: currentTurnIndex + 1 }));
}

async function endSession(sessionId: string, _clientId: string, ws: WebSocket) {
  try {
    await fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    ws.send(JSON.stringify({ type: 'session.ended', sessionId }));
  } catch (err) {
    console.error('[gateway] endSession error:', err);
  }
}

console.log(`[api-gateway] WebSocket endpoint: ws://localhost:${PORT}/v1/sessions/:id/stream`);

process.on('SIGTERM', () => {
  server.close();
  pool.end();
  process.exit(0);
});
