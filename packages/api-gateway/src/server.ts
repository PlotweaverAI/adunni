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

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev_jwt_secret_change_in_production';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'dev_encryption_key_change_in_production';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adunni:adunni_dev_pass@localhost:5432/adunni';
const TLS_CERT = process.env.TLS_CERT_PATH;
const TLS_KEY = process.env.TLS_KEY_PATH;

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
app.use(rateLimitMiddleware({ windowMs: 60_000, maxRequests: 200, skipPaths: ['/health', '/info'] }));
app.use(express.json({ limit: '5mb' }));

const authMiddleware = createAuthMiddleware(JWT_SECRET);

const server = createSecureServer(app, PORT, { certPath: TLS_CERT, keyPath: TLS_KEY, forceHttps: true });
const wss = new WebSocketServer({ server, path: '/v1/sessions/:sessionId/stream' });

app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.1.0' }));

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
  let asrBuffer = '';
  let config: ClientConfig | null = null;
  let sessionActive = true;

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

  ws.on('message', async (data: Buffer) => {
    if (!sessionActive) return;

    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'audio') {
        asrBuffer += Buffer.from(msg.audio, 'base64').toString('utf-8');
        const lines = asrBuffer.split('\n');
        asrBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          await processUserUtterance(line, sessionId, clientId, config, ws, turnIndex);
          turnIndex += 2;
        }
      } else if (msg.type === 'text') {
        await processUserUtterance(msg.text, sessionId, clientId, config, ws, turnIndex);
        turnIndex += 2;
      } else if (msg.type === 'end') {
        await endSession(sessionId, clientId, ws);
        sessionActive = false;
      }
    } catch (err) {
      console.error('[gateway] ws message error:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Processing error' }));
    }
  });

  ws.on('close', async () => {
    if (sessionActive) {
      await endSession(sessionId, clientId, ws);
      sessionActive = false;
    }
    console.log(`[gateway] WebSocket disconnected: session=${sessionId}`);
  });
});

async function processUserUtterance(
  text: string,
  sessionId: string,
  clientId: string,
  config: ClientConfig | null,
  ws: WebSocket,
  currentTurnIndex: number
) {
  const startTime = Date.now();

  const asrResp = await fetch(`${ASR_SERVICE_URL}/detect-language`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const asrResult = await asrResp.json() as { language: LanguageCode; confidence: number };

  await fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      turnIndex: currentTurnIndex,
      speaker: 'user',
      language: asrResult.language,
      text,
      status: 'complete',
      confidence: asrResult.confidence,
      latencyMs: Date.now() - startTime,
    }),
  });

  ws.send(JSON.stringify({
    type: 'transcript',
    turn: { speaker: 'user', language: asrResult.language, text, confidence: asrResult.confidence },
  }));

  const ctxResp = await fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/context`);
  const context = await ctxResp.json() as ConversationContext;

  const orchRequest: OrchestratorRequest = {
    sessionId,
    clientId,
    config: config!,
    context,
    userUtterance: text,
    detectedLanguage: asrResult.language,
    languageConfidence: asrResult.confidence,
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
    : asrResult.language;

  await fetch(`${SESSION_STORE_URL}/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      turnIndex: currentTurnIndex + 1,
      speaker: 'ai',
      language: aiLanguage,
      text: aiText,
      status: 'complete',
      confidence: orchResult.confidence,
      latencyMs: Date.now() - startTime,
      actionId,
    }),
  });

  ws.send(JSON.stringify({
    type: 'transcript',
    turn: { speaker: 'ai', language: aiLanguage, text: aiText, confidence: orchResult.confidence },
  }));

  if (config) {
    try {
      const ttsResp = await fetch(`${TTS_SERVICE_URL}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: aiText,
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
