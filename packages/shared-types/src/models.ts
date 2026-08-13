import type {
  LanguageCode,
  SpeakerRole,
  TurnStatus,
  EscalationReason,
  ActionStatus,
  SessionPhase,
} from './enums.js';

export interface Session {
  id: string;
  clientId: string;
  callerId: string;
  callerPhone?: string;
  phase: SessionPhase;
  startedAt: Date;
  endedAt?: Date;
  preferredLanguage?: LanguageCode;
  metadata: Record<string, unknown>;
}

export interface TranscriptTurn {
  id: string;
  sessionId: string;
  turnIndex: number;
  speaker: SpeakerRole;
  language: LanguageCode;
  text: string;
  englishTranslation?: string;
  status: TurnStatus;
  confidence: number;
  latencyMs?: number;
  actionId?: string;
  escalationReason?: EscalationReason;
  createdAt: Date;
}

export interface ActionLog {
  id: string;
  sessionId: string;
  turnId: string;
  intentName: string;
  actionName: string;
  parameters: Record<string, unknown>;
  status: ActionStatus;
  result?: Record<string, unknown>;
  errorMessage?: string;
  confirmingTurnId?: string;
  executedAt?: Date;
  createdAt: Date;
}

export interface SessionSummary {
  sessionId: string;
  totalTurns: number;
  languagesUsed: LanguageCode[];
  actionsTaken: number;
  escalated: boolean;
  escalationReason?: EscalationReason;
  durationMs: number;
  avgConfidence: number;
}

export interface ConversationContext {
  sessionId: string;
  turns: TranscriptTurn[];
  referencedEntities: Record<string, unknown>;
  lastLanguage: LanguageCode;
  pendingAction?: ActionLog;
  dialogueState: DialogueState;
}

export interface DialogueState {
  currentIntent?: string;
  awaitingConfirmation: boolean;
  slots: Record<string, unknown>;
  escalationActive: boolean;
}
