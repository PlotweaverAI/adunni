import type { LanguageCode } from './enums.js';

export interface ClientConfig {
  clientId: string;
  clientName: string;
  allowedLanguages: LanguageCode[];
  defaultLanguage: LanguageCode;
  voicePersona: VoicePersona;
  intents: IntentConfig[];
  escalationRules: EscalationRules;
  branding?: BrandingConfig;
  webhookUrl?: string;
  webhookSecret?: string;
  ndprConsentMessage: string;
  audioRetentionHours: number;
  transcriptRetentionDays: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface VoicePersona {
  name: string;
  ttsVoiceId: string;
  ttsProvider: string;
  speakingRate: number;
  pitch: number;
}

export interface IntentConfig {
  name: string;
  description: string;
  utteranceExamples: string[];
  actionName: string;
  requiredSlots: string[];
  requiresConfirmation: boolean;
  escalationOnFailure: boolean;
}

export interface EscalationRules {
  confidenceThreshold: number;
  maxRetries: number;
  handoffMode: 'transfer_call' | 'flag_callback' | 'explicit_message';
  handoffPhoneNumber?: string;
  handoffMessage?: string;
}

export interface BrandingConfig {
  primaryColor: string;
  secondaryColor: string;
  logoUrl?: string;
  agentName: string;
  agentSubtitle: string;
}
