import type { LanguageCode } from './enums.js';

export interface AsrChunk {
  text: string;
  isFinal: boolean;
  language: LanguageCode;
  languageConfidence: number;
  textConfidence: number;
  timestampMs: number;
}

export interface AsrStream {
  onChunk: (callback: (chunk: AsrChunk) => void) => void;
  onError: (callback: (error: Error) => void) => void;
  onClose: (callback: () => void) => void;
  sendAudio: (chunk: Buffer) => void;
  close: () => void;
}

export interface AsrProvider {
  name: string;
  supportedLanguages: LanguageCode[];
  createStream: (options: AsrStreamOptions) => AsrStream;
}

export interface AsrStreamOptions {
  sessionId: string;
  languages: LanguageCode[];
  sampleRate: number;
  encoding: 'pcm16' | 'opus' | 'mulaw';
}

export interface AsrService {
  createStream: (options: AsrStreamOptions) => AsrStream;
  detectLanguage: (text: string) => Promise<{ language: LanguageCode; confidence: number }>;
  getProviderInfo: () => { name: string; supportedLanguages: LanguageCode[] };
}
