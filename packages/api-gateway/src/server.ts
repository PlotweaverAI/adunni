import express from 'express';
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

const ASR_SERVICE_URL = process.env.ASR_SERVICE_URL ?? 'http://localhost:3001';
const TTS_SERVICE_URL = process.env.TTS_SERVICE_URL ?? 'http://localhost:3002';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3003';
const ACTION_EXECUTOR_URL = process.env.ACTION_EXECUTOR_URL ?? 'http://localhost:3004';
const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL ?? 'http://localhost:3005';
const SESSION_STORE_URL = process.env.SESSION_STORE_URL ?? 'http://localhost:3006';

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
    console.error('[gateway] createVideoConversation error:', err);
    res.status(500).json({ error: 'Failed to create video conversation', detail: (err as Error).message });
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
  let videoConversation: { conversationId: string; conversationUrl: string } | null = null;

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
        // Buffer chunks until we get a complete utterance (isFinal flag or silence detection)
        const audioChunk = msg.audioBase64 ? Buffer.from(msg.audioBase64, 'base64') : Buffer.from(msg.audio, 'base64');
        audioBuffer.push(audioChunk);

        // If marked as final, transcribe the full buffer via the ASR engine
        if (msg.isFinal) {
          if (audioBuffer.length > 0) {
            const combined = Buffer.concat(audioBuffer);
            audioBuffer = [];

            ws.send(JSON.stringify({ type: 'transcribing' }));

            try {
              const asrEngineResp = await fetch(`${ASR_SERVICE_URL}/transcribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  audio_base64: combined.toString('base64'),
                  encoding: msg.encoding || 'webm',
                  language: msg.language || null,
                }),
                signal: AbortSignal.timeout(120000), // 2 min timeout for model download + inference
              });

              if (asrEngineResp.ok) {
                const asrResult = await asrEngineResp.json() as { text: string; language: LanguageCode; confidence: number };
                if (asrResult.text && asrResult.text.trim()) {
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
                console.error('[gateway] ASR engine error:', asrEngineResp.status);
                ws.send(JSON.stringify({ type: 'error', message: 'Speech recognition failed' }));
              }
            } catch (asrErr) {
              console.error('[gateway] ASR engine error:', asrErr);
              ws.send(JSON.stringify({ type: 'error', message: 'Speech recognition unavailable' }));
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
  } catch (err) {
    console.error('[gateway] setup error:', err);
  }
  setupDone = true;
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
  videoConversation: { conversationId: string; conversationUrl: string } | null = null
) {
  const startTime = Date.now();

  // ── Translation step: translate user utterance to config.translationLanguage ──
  const targetLang = config?.translationLanguage ?? 'en-NG';
  let translatedText = text;
  let userTranslation = '';

  if (language !== targetLang) {
    try {
      const translateResp = await fetch(`${ASR_SERVICE_URL}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source_language: language, target_language: targetLang }),
        signal: AbortSignal.timeout(60000),
      });
      if (translateResp.ok) {
        const translateResult = await translateResp.json() as { translated_text: string };
        translatedText = translateResult.translated_text;
        userTranslation = translatedText;
      }
    } catch (err) {
      console.error('[gateway] translation error (user):', err);
    }
  }

  await fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      turnIndex: currentTurnIndex,
      speaker: 'user',
      language,
      text,
      status: 'complete',
      confidence: languageConfidence,
      latencyMs: Date.now() - startTime,
    }),
  });

  ws.send(JSON.stringify({
    type: 'transcript',
    turn: { speaker: 'user', language, text, confidence: languageConfidence, englishTranslation: userTranslation || undefined },
  }));

  // Send user transcript to video face as echo (so face can react)
  if (videoConversation && tavus) {
    try {
      await tavus.sendEchoMessage(videoConversation.conversationUrl, videoConversation.conversationId, text, {
        inferenceId: `user-${sessionId}-${currentTurnIndex}`,
        done: true,
      });
    } catch (e) {
      console.error('[gateway] video echo (user) error:', e);
    }
  }

  const ctxResp = await fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/context`);
  const context = await ctxResp.json() as ConversationContext;

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
  const orchResult = await orchResp.json() as OrchestratorResponse;
  const decision = orchResult.decision;

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
          turnId: currentTurnIndex,
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
          turnId: currentTurnIndex,
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
        ? `Done. ${decision.actionName} completed successfully.`
        : `I apologize, but I was unable to complete that action: ${execResult.errorMessage}`;
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
          ? 'Confirmed. The action has been completed successfully.'
          : `I was unable to complete the action: ${execResult.errorMessage}`;
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

  const aiLanguage = decision.type === 'respond' || decision.type === 'action' || decision.type === 'escalate' || decision.type === 'clarify'
    ? decision.language
    : language;

  // ── Translate AI response back to user's language if different ──
  let aiTextTranslated = aiText;
  if (language !== targetLang && aiText) {
    try {
      const aiTranslateResp = await fetch(`${ASR_SERVICE_URL}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: aiText, source_language: targetLang, target_language: language }),
        signal: AbortSignal.timeout(60000),
      });
      if (aiTranslateResp.ok) {
        const aiTranslateResult = await aiTranslateResp.json() as { translated_text: string };
        aiTextTranslated = aiTranslateResult.translated_text;
      }
    } catch (err) {
      console.error('[gateway] translation error (AI):', err);
    }
  }

  await fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      turnIndex: currentTurnIndex + 1,
      speaker: 'ai',
      language: aiLanguage,
      text: aiTextTranslated,
      status: 'complete',
      confidence: orchResult.confidence,
      latencyMs: Date.now() - startTime,
      actionId,
    }),
  });

  ws.send(JSON.stringify({
    type: 'transcript',
    turn: { speaker: 'ai', language: aiLanguage, text: aiTextTranslated, confidence: orchResult.confidence, englishTranslation: language !== targetLang ? aiText : undefined },
  }));

  // Send AI response to video face as echo — face will speak with lip-sync
  if (videoConversation && tavus) {
    try {
      await tavus.sendEchoMessage(videoConversation.conversationUrl, videoConversation.conversationId, aiTextTranslated, {
        inferenceId: `ai-${sessionId}-${currentTurnIndex + 1}`,
        done: true,
      });
    } catch (e) {
      console.error('[gateway] video echo (ai) error:', e);
    }
  }

  if (config) {
    try {
      const ttsResp = await fetch(`${TTS_SERVICE_URL}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: aiTextTranslated,
          language: aiLanguage,
          voicePersona: config.voicePersona,
          sessionId,
          turnId: `turn-${currentTurnIndex + 1}`,
        }),
      });
      if (ttsResp.ok) {
        const ttsResult = await ttsResp.json() as { audioBase64: string; format: string; sampleRate: number };
        ws.send(JSON.stringify({
          type: 'audio',
          audioBase64: ttsResult.audioBase64,
          format: ttsResult.format,
          sampleRate: ttsResult.sampleRate,
        }));
      }
    } catch (err) {
      console.error('[gateway] TTS error:', err);
    }
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
