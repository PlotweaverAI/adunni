import express from 'express';
import { AsrServiceImpl } from './asr-service.js';
import type { LanguageCode } from '@adunni/shared-types';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const SUPPORTED_LANGUAGES = (process.env.SUPPORTED_LANGUAGES ?? 'en-NG,pcm,yo,ig,ha').split(',') as LanguageCode[];

const asrService = new AsrServiceImpl();
const app = express();
app.use(express.raw({ type: 'application/octet-stream', limit: '10mb' }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', provider: asrService.getProviderInfo() }));

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

app.listen(PORT, () => {
  console.log(`[asr-service] listening on :${PORT}`);
});
