import type { SessionPhase, LanguageCode } from './enums.js';
import type {
  Session,
  TranscriptTurn,
  ActionLog,
  SessionSummary,
  ConversationContext,
} from './models.js';

export interface SessionStoreService {
  createSession: (params: CreateSessionParams) => Promise<Session>;
  getSession: (sessionId: string) => Promise<Session | null>;
  updateSessionPhase: (sessionId: string, phase: SessionPhase) => Promise<void>;
  endSession: (sessionId: string, summary?: Partial<SessionSummary>) => Promise<void>;

  addTurn: (turn: Omit<TranscriptTurn, 'id' | 'createdAt'>) => Promise<TranscriptTurn>;
  getTurns: (sessionId: string) => Promise<TranscriptTurn[]>;
  getConversationContext: (sessionId: string) => Promise<ConversationContext>;

  createAction: (action: Omit<ActionLog, 'id' | 'createdAt'>) => Promise<ActionLog>;
  updateAction: (actionId: string, updates: Partial<ActionLog>) => Promise<void>;
  getActions: (sessionId: string) => Promise<ActionLog[]>;

  getSessionSummary: (sessionId: string) => Promise<SessionSummary>;

  getTranscript: (sessionId: string) => Promise<{
    session: Session;
    turns: TranscriptTurn[];
    actions: ActionLog[];
    summary: SessionSummary;
  }>;
}

export interface CreateSessionParams {
  clientId: string;
  callerId: string;
  callerPhone?: string;
  preferredLanguage?: LanguageCode;
  metadata?: Record<string, unknown>;
}
