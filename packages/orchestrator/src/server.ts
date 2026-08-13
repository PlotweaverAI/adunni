import express from 'express';
import { OrchestratorServiceImpl } from './orchestrator-service.js';
import type { OrchestratorRequest } from '@adunni/shared-types';

const PORT = parseInt(process.env.PORT ?? '3003', 10);
const orchestrator = new OrchestratorServiceImpl();
const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/process', async (req, res) => {
  try {
    const request = req.body as OrchestratorRequest;
    if (!request.sessionId || !request.userUtterance) {
      return res.status(400).json({ error: 'sessionId and userUtterance are required' });
    }
    const response = await orchestrator.process(request);
    res.json(response);
  } catch (err) {
    console.error('[orchestrator] process error:', err);
    res.status(500).json({ error: 'Orchestration failed' });
  }
});

app.post('/system-prompt', (req, res) => {
  try {
    const { config } = req.body;
    if (!config) return res.status(400).json({ error: 'config is required' });
    res.json({ systemPrompt: orchestrator.buildSystemPrompt(config) });
  } catch (err) {
    console.error('[orchestrator] system-prompt error:', err);
    res.status(500).json({ error: 'Failed to build system prompt' });
  }
});

app.listen(PORT, () => {
  console.log(`[orchestrator] listening on :${PORT}`);
});
