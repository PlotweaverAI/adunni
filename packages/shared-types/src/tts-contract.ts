import type { LanguageCode } from './enums.js';
import type { VoicePersona } from './config.js';

export interface TtsRequest {
  text: string;
  language: LanguageCode;
  voicePersona: VoicePersona;
  sessionId: string;
  turnId: string;
}

export interface TtsChunk {
  audio: Buffer;
  isFinal: boolean;
  format: 'pcm16' | 'opus' | 'mp3';
  sampleRate: number;
}

export interface TtsStream {
  onChunk: (callback: (chunk: TtsChunk) => void) => void;
  onError: (callback: (error: Error) => void) => void;
  onClose: (callback: () => void) => void;
  close: () => void;
}

export interface TtsProvider {
  name: string;
  supportedLanguages: LanguageCode[];
  synthesize: (request: TtsRequest) => TtsStream;
}

export interface TtsService {
  synthesize: (request: TtsRequest) => TtsStream;
  getProviderInfo: () => { name: string; supportedLanguages: LanguageCode[] };
}
