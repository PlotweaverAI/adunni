import express from 'express';
import { OrchestratorServiceImpl } from './orchestrator-service.js';
import { GeminiLlmProvider } from './gemini-llm.js';
import type { OrchestratorRequest } from '@adunni/shared-types';

const PORT = parseInt(process.env.PORT ?? '3003', 10);

// Use Gemini Flash if API key is set, otherwise fall back to mock
const geminiKey = process.env.GEMINI_API_KEY;
const llm = geminiKey ? new GeminiLlmProvider(geminiKey) : undefined;
if (llm) {
  console.log('[orchestrator] Using Gemini Flash LLM provider');
} else {
  console.log('[orchestrator] GEMINI_API_KEY not set — using MockLlmProvider (limited functionality)');
}

const orchestrator = new OrchestratorServiceImpl(llm);
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

// Streaming endpoint — emits SSE events as LLM generates text
// Events:
//   data: {"type":"text","chunk":"Hello"}    — text chunk from LLM
//   data: {"type":"done","response":{...}}   — final orchestrator response
app.post('/process-stream', async (req, res) => {
  try {
    const request = req.body as OrchestratorRequest;
    if (!request.sessionId || !request.userUtterance) {
      return res.status(400).json({ error: 'sessionId and userUtterance are required' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const response = await orchestrator.processStream(request, (chunk: string) => {
      res.write(`data: ${JSON.stringify({ type: 'text', chunk })}\n\n`);
    });

    res.write(`data: ${JSON.stringify({ type: 'done', response })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[orchestrator] process-stream error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Orchestration failed' })}\n\n`);
    res.end();
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
