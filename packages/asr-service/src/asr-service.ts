import type {
  AsrService,
  AsrStream,
  AsrStreamOptions,
  AsrChunk,
  AsrProvider,
  LanguageCode,
} from '@adunni/shared-types';

const LANGUAGE_KEYWORDS: Record<LanguageCode, string[]> = {
  'en-NG': ['the', 'is', 'are', 'was', 'were', 'have', 'has', 'please', 'account', 'balance', 'transfer', 'limit', 'money', 'bank', 'error', 'morning', 'afternoon', 'hello', 'want', 'need', 'check', 'would', 'could', 'should', 'thank', 'welcome', 'help', 'card', 'pin', 'loan', 'savings', 'deposit', 'withdraw', 'statement'],
  'pcm': ['abeg', 'na', 'dey', 'wan', 'wahala', 'naija', 'wetin', 'far', 'don', 'one-time', 'show', 'sabi', 'papa', 'mama', 'chop', 'gos', 'beta', 'oga', 'madam', 'broda', 'sista', 'pikin', 'no', 'fit', 'make', 'wey', 'say', 'go', 'come', 'see', 'know', 'give', 'tell', 'ask', 'work', 'good', 'bad', 'big', 'small', 'howfar', 'watin', 'wetin', 'chop', 'drink', 'sleep', 'wake', 'buy', 'sell', 'pay', 'owe', 'borrow', 'lend', 'send', 'receive'],
  'yo': ['bawo', 'e', 'ka', 'aro', 'kabo', 'soro', 'ede', 'owo', 'akanti', 'kuro', 'se', 'fowo', 'ranse', 'yin', 'mo', 'fe', 'ni', 'wa', 'nkan', 'nwon', 'kilode', 'da', 'lo', 'ti', 'n', 'a', 'wa', 'e', 'o', 'un', 'an', 'iru', 'eyi', 'naa', 'mi', 're', 'wa', 'yin', 'won', 'nbe', 'si', 'lati', 'si', 'fun', 'pelu', 'nipin', 'le', 'lori', 'abe', 'leyin', 'iwaju', 'ehin', 'okunrin', 'obinrin', 'omode', 'agba', 'ile', 'oko', 'ose', 'ose', 'aaro', 'osan', 'iro', 'ale', 'orun', 'ojo', 'osu', 'odu', 'odun'],
  'ig': ['daalu', 'ndewo', 'biko', 'nna', 'nne', 'unu', 'anyi', 'mu', 'gi', 'ya', 'ha', 'ndi', 'ole', 'kedu', 'mma', 'ojo', 'ego', 'ahu', 'ulo', 'akwukwo', 'mmiri', 'oru', 'ubochi', 'abali', 'ututu', 'ehihie', 'ugbo', 'udu', 'ahu', 'ime', 'ime', 'nke', 'ukwuu', 'obere', 'nnukwu', 'na', 'na', 'ga', 'ga', 'cho', 'cho', 'ma', 'ma', 'were', 'were', 'bịa', 'bịa', 'gaa', 'gaa', 'sị', 'sị', 'mara', 'mara', 'ma', 'ma', 'bịa', 'nụ', 'nụ', 'ọma', 'ọjọ', 'ego', 'ụlọ', 'akwụkwọ', 'mmiri', 'ọrụ', 'ụbọchị'],
  'ha': ['ina', 'sanin', 'son', 'adadin', 'kudin', 'cikin', 'asusun', 'na', 'ba', 'ko', 'da', 'ga', 'na', 'ka', 'ki', 'ke', 'ku', 'su', 'mu', 'ta', 'ya', 'yi', 'ce', 'ta', 'sai', 'amince', 'gaba', 'kawai', 'take', 'ji', 'mana', 'zan', 'aika', 'mata', 'sako', 'tabbatarwa', 'karbi', 'daga', 'komai', 'shirye', 'yake', 'madalla', 'iya', 'ci', 'za', 'hausa', 'mahaifiyata', 'gida', 'kudi', 'asusu', 'bashin', 'rancen', 'adaka', 'makubban', 'satar', 'banci', 'ceto', 'kwaso', 'riba', 'kudi', 'kudi'],
};

// High-weight marker words unique to each language (score 3x per match)
const LANGUAGE_MARKERS: Record<LanguageCode, string[]> = {
  'en-NG': [],
  'pcm': ['abeg', 'na', 'dey', 'wan', 'wahala', 'naija', 'wetin', 'sabi', 'howfar', 'watin', 'oga', 'madam', 'broda', 'sista', 'pikin', 'wey', 'gos', 'beta', 'chop'],
  'yo': ['bawo', 'kilode', 'kabo', 'soro', 'akanti', 'fowo', 'ranse', 'nkan', 'nwon', 'okunrin', 'obinrin', 'omode', 'agba'],
  'ig': ['biko', 'daalu', 'ndewo', 'kedu', 'nna', 'nne', 'unu', 'anyi', 'mmiri', 'akwukwo', 'ubochi', 'ehihie', 'ututu'],
  'ha': ['madalla', 'amince', 'mahaifiyata', 'tabbatarwa', 'karbi', 'shirye', 'kwaso', 'bashin', 'rancen', 'makubban', 'satar', 'banci'],
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
    const words = new Set(lower.split(/[\s,.;:!?'"\-()]+/).filter(w => w.length > 0));

    // Pidgin catchphrase override: if any Pidgin marker is present, it's Pidgin
    const pcmMarkers = ['abeg', 'dey', 'wan', 'wahala', 'naija', 'wetin', 'sabi', 'howfar', 'watin', 'oga', 'madam', 'broda', 'sista', 'pikin', 'wey', 'gos', 'beta', 'chop'];
    for (const marker of pcmMarkers) {
      if (lower.includes(marker)) {
        return { language: 'pcm', confidence: 0.95 };
      }
    }

    const scores: Record<LanguageCode, number> = { 'en-NG': 0, 'pcm': 0, 'yo': 0, 'ig': 0, 'ha': 0 };

    // Regular keyword matching
    for (const [lang, keywords] of Object.entries(LANGUAGE_KEYWORDS)) {
      for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        if (kwLower.length <= 3) {
          if (words.has(kwLower)) {
            scores[lang as LanguageCode] += 1;
          }
        } else {
          if (lower.includes(kwLower)) {
            scores[lang as LanguageCode] += 1;
          }
        }
      }
    }

    // High-weight marker matching (3x score per match)
    for (const [lang, markers] of Object.entries(LANGUAGE_MARKERS)) {
      for (const kw of markers) {
        const kwLower = kw.toLowerCase();
        if (kwLower.length <= 3) {
          if (words.has(kwLower)) {
            scores[lang as LanguageCode] += 3;
          }
        } else {
          if (lower.includes(kwLower)) {
            scores[lang as LanguageCode] += 3;
          }
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
