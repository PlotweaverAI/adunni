import express from 'express';
import { AsrServiceImpl } from './asr-service.js';
import type { LanguageCode } from '@adunni/shared-types';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const SUPPORTED_LANGUAGES = (process.env.SUPPORTED_LANGUAGES ?? 'en-NG,pcm,yo,ig,ha').split(',') as LanguageCode[];

const asrService = new AsrServiceImpl();
const app = express();
app.use(express.raw({ type: 'application/octet-stream', limit: '25mb' }));
app.use(express.json({ limit: '25mb' }));

app.get('/health', async (_req, res) => {
  // Do a fresh engine health check instead of returning stale cached status
  await asrService.checkEngineHealth();
  res.json({ status: 'ok', provider: asrService.getProviderInfo() });
});

app.post('/detect-language', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    const result = await asrService.detectLanguage(text);
    res.json(result);
  } catch (err) {
    console.error('[asr] detectLanguage error:', err);
    res.status(500).json({ error: 'Detection failed' });
  }
});

app.get('/info', (_req, res) => {
  res.json({
    provider: asrService.getProviderInfo(),
    supportedLanguages: SUPPORTED_LANGUAGES,
  });
});

// Proxy /transcribe to the Python ASR engine (if configured)
app.post('/transcribe', async (req, res) => {
  const engineUrl = process.env.ASR_ENGINE_URL;
  if (!engineUrl) {
    return res.status(501).json({ error: 'ASR engine not configured' });
  }
  try {
    const resp = await fetch(`${engineUrl}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(120000),
    });
    const data = await resp.text();
    res.status(resp.status).type('json').send(data);
  } catch (err) {
    console.error('[asr] transcribe proxy error:', err);
    res.status(502).json({ error: 'ASR engine unreachable' });
  }
});

// Proxy /transcribe/partial for streaming partial transcripts
app.post('/transcribe/partial', async (req, res) => {
  const engineUrl = process.env.ASR_ENGINE_URL;
  if (!engineUrl) {
    return res.status(501).json({ error: 'ASR engine not configured' });
  }
  try {
    const resp = await fetch(`${engineUrl}/transcribe/partial`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(60000),
    });
    const data = await resp.text();
    res.status(resp.status).type('json').send(data);
  } catch (err) {
    console.error('[asr] partial transcribe proxy error:', err);
    res.status(502).json({ error: 'ASR engine unreachable' });
  }
});

// Proxy /vad for voice activity detection
app.post('/vad', async (req, res) => {
  const engineUrl = process.env.ASR_ENGINE_URL;
  if (!engineUrl) {
    return res.status(501).json({ error: 'ASR engine not configured' });
  }
  try {
    const resp = await fetch(`${engineUrl}/vad`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.text();
    res.status(resp.status).type('json').send(data);
  } catch (err) {
    console.error('[asr] VAD proxy error:', err);
    res.status(502).json({ error: 'ASR engine unreachable' });
  }
});

app.post('/translate', async (req, res) => {
  const engineUrl = process.env.ASR_ENGINE_URL;
  if (!engineUrl) {
    return res.status(501).json({ error: 'ASR engine not configured' });
  }
  try {
    const resp = await fetch(`${engineUrl}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(60000),
    });
    const data = await resp.text();
    res.status(resp.status).type('json').send(data);
  } catch (err) {
    console.error('[asr] translate proxy error:', err);
    res.status(502).json({ error: 'ASR engine unreachable' });
  }
});

app.listen(PORT, () => {
  console.log(`[asr-service] listening on :${PORT}`);
  console.log(`[asr-service] engine: ${process.env.ASR_ENGINE_URL ?? 'none (using mock)'}`);
});
