import express from 'express';
import { TtsServiceImpl } from './tts-service.js';
import type { TtsRequest } from '@adunni/shared-types';

const PORT = parseInt(process.env.PORT ?? '3002', 10);
const ttsService = new TtsServiceImpl();
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', provider: ttsService.getProviderInfo() }));

app.post('/synthesize', (req, res) => {
  try {
    const { text, language, voicePersona, sessionId, turnId } = req.body as TtsRequest;
    if (!text || !language) {
      return res.status(400).json({ error: 'text and language are required' });
    }

    const stream = ttsService.synthesize({ text, language, voicePersona, sessionId, turnId });
    const chunks: Buffer[] = [];

    stream.onChunk((chunk) => {
      if (chunk.isFinal) {
        const fullAudio = Buffer.concat(chunks);
        res.json({
          audioBase64: fullAudio.toString('base64'),
          format: 'pcm16',
          sampleRate: 16000,
          sessionId,
          turnId,
        });
      } else {
        chunks.push(chunk.audio);
      }
    });

    stream.onError((err) => {
      console.error('[tts] stream error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'TTS synthesis failed' });
    });
  } catch (err) {
    console.error('[tts] synthesize error:', err);
    res.status(500).json({ error: 'TTS synthesis failed' });
  }
});

app.get('/info', (_req, res) => {
  res.json({ provider: ttsService.getProviderInfo() });
});

app.listen(PORT, () => {
  console.log(`[tts-service] listening on :${PORT}`);
});
