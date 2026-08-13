import type { LanguageCode, EscalationReason } from './enums.js';
import type { ConversationContext } from './models.js';
import type { ClientConfig, IntentConfig } from './config.js';

export type OrchestratorDecision =
  | { type: 'respond'; text: string; language: LanguageCode; englishTranslation?: string }
  | { type: 'action'; intentName: string; actionName: string; parameters: Record<string, unknown>; requiresConfirmation: boolean; confirmationPrompt: string; language: LanguageCode }
  | { type: 'confirm_action'; actionId: string; confirmed: boolean; language: LanguageCode }
  | { type: 'escalate'; reason: EscalationReason; message: string; language: LanguageCode }
  | { type: 'clarify'; prompt: string; language: LanguageCode };

export interface OrchestratorRequest {
  sessionId: string;
  clientId: string;
  config: ClientConfig;
  context: ConversationContext;
  userUtterance: string;
  detectedLanguage: LanguageCode;
  languageConfidence: number;
}

export interface OrchestratorResponse {
  decision: OrchestratorDecision;
  intentName?: string;
  confidence: number;
  updatedContext: ConversationContext;
  latencyMs: number;
}

export interface LlmProvider {
  name: string;
  complete: (request: LlmRequest) => Promise<LlmResponse>;
}

export interface LlmRequest {
  systemPrompt: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  userMessage: string;
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  maxTokens: number;
  temperature: number;
}

export interface LlmResponse {
  text: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface OrchestratorService {
  process: (request: OrchestratorRequest) => Promise<OrchestratorResponse>;
  buildSystemPrompt: (config: ClientConfig) => string;
  buildTools: (intents: IntentConfig[]) => LlmRequest['tools'];
}
