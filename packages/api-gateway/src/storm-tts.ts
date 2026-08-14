/**
 * STORM TTS Client — Plotweaver's Nigerian multilingual TTS API
 *
 * Wraps the STORM TTS inference server (Orpheus-3B fine-tune) that produces
 * speech in Yoruba, Hausa, Igbo, Nigerian Pidgin, and Nigerian English.
 *
 * API docs: STORM_TTS_API_DOCS.md in plotweaver-model-training repo
 * Base URL: http://54.198.152.226:8000
 */

// Default speaker IDs per language (from /speakers endpoint)
const DEFAULT_SPEAKERS: Record<string, string> = {
  'yo':    'company_aa5991b6-683c-4382-a842-5d6ec363f4c8', // Morenike (61.7h)
  'ha':    'company_deb93079-0424-4c42-b1b7-68008301c0e1', // Amina (27.6h)
  'ig':    'company_deb93079-0424-4c42-b1b7-68008301c0e1', // Amina (cross-lingual fallback; Igbo speaker TBD)
  'pcm':   'company_aa5991b6-683c-4382-a842-5d6ec363f4c8', // Morenike (cross-lingual fallback for Pidgin)
  'en-NG': 'company_aa5991b6-683c-4382-a842-5d6ec363f4c8', // Morenike (cross-lingual for Nigerian English)
};

// Map Adunni language codes to STORM TTS language codes
const LANG_MAP: Record<string, string> = {
  'en-NG': 'en-NG',
  'pcm':   'pcm',
  'yo':    'yo',
  'ig':    'ig',
  'ha':    'ha',
};

export class StormTtsClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(apiKey: string, baseUrl: string = 'http://54.198.152.226:8000') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  /**
   * Generate speech audio as a WAV buffer.
   *
   * @param text The text to synthesize
   * @param language Adunni LanguageCode (e.g. 'yo', 'ha', 'ig', 'pcm', 'en-NG')
   * @param speakerId Optional speaker ID. If omitted, uses the default for the language.
   * @returns { audio: Buffer, format: 'wav', sampleRate: 24000 }
   */
  async generate(
    text: string,
    language: string,
    speakerId?: string,
  ): Promise<{ audio: Buffer; format: 'wav'; sampleRate: 24000 }> {
    const lang = LANG_MAP[language] ?? 'en-NG';
    const speaker = speakerId ?? DEFAULT_SPEAKERS[lang] ?? DEFAULT_SPEAKERS['en-NG'];

    const resp = await fetch(`${this.baseUrl}/generate`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ speaker_id: speaker, text }),
      signal: AbortSignal.timeout(60000), // STORM TTS takes ~6s on GPU
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`STORM TTS generate failed (${resp.status}): ${errBody.substring(0, 200)}`);
    }

    const audioBuffer = Buffer.from(await resp.arrayBuffer());
    return { audio: audioBuffer, format: 'wav' as const, sampleRate: 24000 };
  }

  /**
   * Check if the STORM TTS server is healthy.
   */
  async health(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available speakers grouped by language.
   */
  async listSpeakers(): Promise<Record<string, unknown>> {
    const resp = await fetch(`${this.baseUrl}/speakers`, {
      headers: { 'X-API-Key': this.apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      throw new Error(`STORM TTS speakers failed (${resp.status})`);
    }
    return await resp.json() as Record<string, unknown>;
  }
}
