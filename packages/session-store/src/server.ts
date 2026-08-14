import express from 'express';
import { SessionStore } from './session-store.js';

const PORT = parseInt(process.env.PORT ?? '3006', 10);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adunni:adunni_dev_pass@localhost:5432/adunni';

const store = new SessionStore(DATABASE_URL);
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/sessions', async (req, res) => {
  try {
    const { clientId, callerId, callerPhone, preferredLanguage, metadata } = req.body;
    if (!clientId || !callerId) {
      return res.status(400).json({ error: 'clientId and callerId are required' });
    }
    const session = await store.createSession({ clientId, callerId, callerPhone, preferredLanguage, metadata });
    res.status(201).json(session);
  } catch (err) {
    console.error('[session-store] createSession error:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.get('/sessions/:sessionId', async (req, res) => {
  try {
    const session = await store.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err) {
    console.error('[session-store] getSession error:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

app.patch('/sessions/:sessionId/phase', async (req, res) => {
  try {
    const { phase } = req.body;
    await store.updateSessionPhase(req.params.sessionId, phase);
    res.json({ status: 'updated' });
  } catch (err) {
    console.error('[session-store] updatePhase error:', err);
    res.status(500).json({ error: 'Failed to update phase' });
  }
});

app.post('/sessions/:sessionId/end', async (req, res) => {
  try {
    await store.endSession(req.params.sessionId, req.body);
    res.json({ status: 'ended' });
  } catch (err) {
    console.error('[session-store] endSession error:', err);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

app.post('/sessions/:sessionId/turns', async (req, res) => {
  try {
    const turn = await store.addTurn(req.body);
    res.status(201).json(turn);
  } catch (err) {
    console.error('[session-store] addTurn error:', err);
    res.status(500).json({ error: 'Failed to add turn' });
  }
});

app.get('/sessions/:sessionId/turns', async (req, res) => {
  try {
    const turns = await store.getTurns(req.params.sessionId);
    res.json(turns);
  } catch (err) {
    console.error('[session-store] getTurns error:', err);
    res.status(500).json({ error: 'Failed to get turns' });
  }
});

app.get('/sessions/:sessionId/context', async (req, res) => {
  try {
    const ctx = await store.getConversationContext(req.params.sessionId);
    res.json(ctx);
  } catch (err) {
    console.error('[session-store] getContext error:', err);
    res.status(500).json({ error: 'Failed to get context' });
  }
});

app.post('/sessions/:sessionId/actions', async (req, res) => {
  try {
    const action = await store.createAction(req.body);
    res.status(201).json(action);
  } catch (err) {
    console.error('[session-store] createAction error:', err);
    res.status(500).json({ error: 'Failed to create action' });
  }
});

app.patch('/actions/:actionId', async (req, res) => {
  try {
    await store.updateAction(req.params.actionId, req.body);
    res.json({ status: 'updated' });
  } catch (err) {
    console.error('[session-store] updateAction error:', err);
    res.status(500).json({ error: 'Failed to update action' });
  }
});

app.get('/sessions/:sessionId/actions', async (req, res) => {
  try {
    const actions = await store.getActions(req.params.sessionId);
    res.json(actions);
  } catch (err) {
    console.error('[session-store] getActions error:', err);
    res.status(500).json({ error: 'Failed to get actions' });
  }
});

app.get('/sessions/:sessionId/transcript', async (req, res) => {
  try {
    const transcript = await store.getTranscript(req.params.sessionId);
    res.json(transcript);
  } catch (err) {
    console.error('[session-store] getTranscript error:', err);
    const status = (err as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

app.get('/sessions/:sessionId/summary', async (req, res) => {
  try {
    const summary = await store.getSessionSummary(req.params.sessionId);
    res.json(summary);
  } catch (err) {
    console.error('[session-store] getSummary error:', err);
    res.status(500).json({ error: 'Failed to get summary' });
  }
});

// ── GET /clients/:clientId/recent-turns — Cross-session memory ──
app.get('/clients/:clientId/recent-turns', async (req, res) => {
  try {
    const limit = parseInt(req.query['limit'] as string ?? '10', 10);
    const turns = await store.getRecentTurnsByClient(req.params.clientId, limit);
    res.json(turns);
  } catch (err) {
    console.error('[session-store] getRecentTurnsByClient error:', err);
    res.status(500).json({ error: 'Failed to get recent turns' });
  }
});

// Cross-session memory: get recent turns for a client across all sessions
app.get('/clients/:clientId/recent-turns', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string ?? '10', 10);
    const turns = await store.getRecentTurnsByClient(req.params.clientId, limit);
    res.json(turns);
  } catch (err) {
    console.error('[session-store] getRecentTurns error:', err);
    res.status(500).json({ error: 'Failed to get recent turns' });
  }
});

app.listen(PORT, () => {
  console.log(`[session-store] listening on :${PORT}`);
});

process.on('SIGTERM', async () => {
  await store.close();
  process.exit(0);
});
