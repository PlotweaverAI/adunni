import type {
  AsrService,
  AsrStream,
  AsrStreamOptions,
  AsrChunk,
  AsrProvider,
  LanguageCode,
} from '@adunni/shared-types';

const LANGUAGE_KEYWORDS: Record<LanguageCode, string[]> = {
  'en-NG': ['the', 'is', 'are', 'was', 'have', 'please', 'account', 'balance', 'transfer', 'limit', 'money', 'bank', 'error', 'morning', 'afternoon'],
  'pcm': ['abeg', 'na', 'dey', 'wan', 'give', 'my', 'mama', 'wahala', 'make', 'i', 'naija', 'wetin', 'how', 'far', 'e', 'don', 'one-time', 'show'],
  'yo': ['Ẹ', 'káàbọ̀', 'sọ̀rọ̀', 'èdè', 'owó', 'àkántì', 'kúrò', 'ṣé', 'rárã', 'fọwọ́', 'ránṣẹ́', 'pátápátá', 'léṣẹ̀kẹṣẹ̀', 'àkántì', 'yín'],
  'ig': ['Daalụ', 'Ị', 'na-asụ', 'Igbo', 'ego', 'ahụ', 'eruola', 'ọma', 'a', 'na', 'm', 'asụ', 'nke', 'ukwuu'],
  'ha': ['Madalla', 'Za', 'ka', 'iya', 'ci', 'gaba', 'da', 'Hausa', 'Mahaifiyata', 'kawai', 'take', 'ji', 'Ī', 'mana', 'Zan', 'aika', 'mata', 'saƙon', 'tabbatarwa', 'karɓi', 'daga', 'Komai', 'shirye', 'yake', 'sai', 'amince'],
};

// ── Mock provider (keyword-based detection, used as fallback) ──
export class MockAsrProvider implements AsrProvider {
  name = 'mock-asr';
  supportedLanguages: LanguageCode[] = ['en-NG', 'pcm', 'yo', 'ig', 'ha'];

  createStream(_options: AsrStreamOptions): AsrStream {
    let buffer = '';
    let closed = false;
    const chunkCallbacks: Array<(chunk: AsrChunk) => void> = [];
    const errorCallbacks: Array<(error: Error) => void> = [];
    const closeCallbacks: Array<() => void> = [];

    return {
      onChunk: (cb) => chunkCallbacks.push(cb),
      onError: (cb) => errorCallbacks.push(cb),
      onClose: (cb) => closeCallbacks.push(cb),
      sendAudio: (data: Buffer) => {
        if (closed) return;
        buffer += data.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const { language, confidence } = this.detectLanguageFromText(line);
          const chunk: AsrChunk = {
            text: line,
            isFinal: true,
            language,
            languageConfidence: confidence,
            textConfidence: 0.92,
            timestampMs: Date.now(),
          };
          chunkCallbacks.forEach((cb) => cb(chunk));
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (buffer.trim()) {
          const { language, confidence } = this.detectLanguageFromText(buffer);
          chunkCallbacks.forEach((cb) => cb({
            text: buffer,
            isFinal: true,
            language,
            languageConfidence: confidence,
            textConfidence: 0.90,
            timestampMs: Date.now(),
          }));
        }
        closeCallbacks.forEach((cb) => cb());
      },
    };
  }

  detectLanguageFromText(text: string): { language: LanguageCode; confidence: number } {
    const lower = text.toLowerCase();
    const scores: Record<LanguageCode, number> = { 'en-NG': 0, 'pcm': 0, 'yo': 0, 'ig': 0, 'ha': 0 };

    for (const [lang, keywords] of Object.entries(LANGUAGE_KEYWORDS)) {
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) {
          scores[lang as LanguageCode] += 1;
        }
      }
    }

    let best: LanguageCode = 'en-NG';
    let bestScore = 0;
    for (const [lang, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        best = lang as LanguageCode;
      }
    }

    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    const confidence = total > 0 ? bestScore / total : 0.5;

    return { language: best, confidence: Math.max(0.5, confidence) };
  }
}

// ── Engine provider (proxies to the Python asr-engine service) ──
export class EngineAsrProvider implements AsrProvider {
  name = 'ncair1-whisper';
  supportedLanguages: LanguageCode[] = ['en-NG', 'pcm', 'yo', 'ig', 'ha'];

  constructor(private engineUrl: string) {}

  createStream(options: AsrStreamOptions): AsrStream {
    // For streaming audio, we buffer and send chunks to the engine's /transcribe endpoint
    let closed = false;
    let audioBuffer: Buffer[] = [];
    const chunkCallbacks: Array<(chunk: AsrChunk) => void> = [];
    const errorCallbacks: Array<(error: Error) => void> = [];
    const closeCallbacks: Array<() => void> = [];

    return {
      onChunk: (cb) => chunkCallbacks.push(cb),
      onError: (cb) => errorCallbacks.push(cb),
      onClose: (cb) => closeCallbacks.push(cb),
      sendAudio: (data: Buffer) => {
        if (closed) return;
        audioBuffer.push(data);
      },
      close: async () => {
        if (closed) return;
        closed = true;

        if (audioBuffer.length === 0) {
          closeCallbacks.forEach((cb) => cb());
          return;
        }

        try {
          const combined = Buffer.concat(audioBuffer);
          const audioBase64 = combined.toString('base64');

          const resp = await fetch(`${this.engineUrl}/transcribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              audio_base64: audioBase64,
              encoding: options.encoding === 'pcm16' ? 'wav' : options.encoding,
              language: options.languages[0] ?? null,
            }),
          });

          if (!resp.ok) {
            throw new Error(`Engine transcribe failed: ${resp.status}`);
          }

          const result = await resp.json() as { text: string; language: LanguageCode; confidence: number };
          chunkCallbacks.forEach((cb) => cb({
            text: result.text,
            isFinal: true,
            language: result.language,
            languageConfidence: result.confidence,
            textConfidence: 0.95,
            timestampMs: Date.now(),
          }));
        } catch (err) {
          errorCallbacks.forEach((cb) => cb(err as Error));
        }

        closeCallbacks.forEach((cb) => cb());
      },
    };
  }
}

// ── ASR Service implementation ──
export class AsrServiceImpl implements AsrService {
  private provider: AsrProvider;
  private engineUrl: string | null;
  private engineAvailable: boolean | null = null;

  constructor(provider?: AsrProvider) {
    this.engineUrl = process.env.ASR_ENGINE_URL ?? null;
    this.provider = provider ?? (this.engineUrl ? new EngineAsrProvider(this.engineUrl) : new MockAsrProvider());
  }

  createStream(options: AsrStreamOptions): AsrStream {
    return this.provider.createStream(options);
  }

  async detectLanguage(text: string): Promise<{ language: LanguageCode; confidence: number }> {
    // Try the Python engine first if configured
    if (this.engineUrl) {
      try {
        const resp = await fetch(`${this.engineUrl}/detect-language`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          this.engineAvailable = true;
          return await resp.json() as { language: LanguageCode; confidence: number };
        }
      } catch {
        this.engineAvailable = false;
        // Fall back to mock detection
      }
    }

    // Fallback: use mock keyword-based detection
    if (this.provider instanceof MockAsrProvider) {
      return this.provider.detectLanguageFromText(text);
    }
    return { language: 'en-NG', confidence: 0.5 };
  }

  getProviderInfo() {
    const info = {
      name: this.provider.name,
      supportedLanguages: this.provider.supportedLanguages,
      engine: this.engineUrl ?? 'none',
      engineAvailable: this.engineAvailable,
    };
    return info;
  }
}
