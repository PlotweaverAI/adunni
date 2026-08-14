import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type {
  SessionStoreService,
  CreateSessionParams,
  Session,
  TranscriptTurn,
  ActionLog,
  SessionSummary,
  ConversationContext,
  SessionPhase,
  LanguageCode,
  SpeakerRole,
  TurnStatus,
  ActionStatus,
  EscalationReason,
} from '@adunni/shared-types';

export class SessionStore implements SessionStoreService {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 20 });
  }

  async createSession(params: CreateSessionParams): Promise<Session> {
    const { rows } = await this.pool.query(
      `INSERT INTO sessions (client_id, caller_id, caller_phone, caller_phone_hash, preferred_language, metadata, phase)
       VALUES ($1, $2, $3, $4, $5, $6, 'connecting')
       RETURNING *`,
      [
        params.clientId,
        params.callerId,
        params.callerPhone ?? null,
        params.callerPhoneHash ?? null,
        params.preferredLanguage ?? null,
        JSON.stringify(params.metadata ?? {}),
      ]
    );
    return this.rowToSession(rows[0]);
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM sessions WHERE id = $1',
      [sessionId]
    );
    return rows[0] ? this.rowToSession(rows[0]) : null;
  }

  async updateSessionPhase(sessionId: string, phase: SessionPhase): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET phase = $1 WHERE id = $2',
      [phase, sessionId]
    );
  }

  async endSession(sessionId: string, summary?: Partial<SessionSummary>): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET phase = $1, ended_at = NOW() WHERE id = $2',
      [summary?.escalated ? 'escalated' : 'ended', sessionId]
    );
  }

  async addTurn(turn: Omit<TranscriptTurn, 'id' | 'createdAt'>): Promise<TranscriptTurn> {
    const id = uuidv4();
    const { rows } = await this.pool.query(
      `INSERT INTO transcript_turns (id, session_id, turn_index, speaker, language, text, english_translation, status, confidence, latency_ms, action_id, escalation_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        id,
        turn.sessionId,
        turn.turnIndex,
        turn.speaker,
        turn.language,
        turn.text,
        turn.englishTranslation ?? null,
        turn.status,
        turn.confidence,
        turn.latencyMs ?? null,
        turn.actionId ?? null,
        turn.escalationReason ?? null,
      ]
    );
    return this.rowToTurn(rows[0]);
  }

  async getTurns(sessionId: string): Promise<TranscriptTurn[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM transcript_turns WHERE session_id = $1 ORDER BY turn_index ASC',
      [sessionId]
    );
    return rows.map((r) => this.rowToTurn(r));
  }

  /**
   * Get recent turns across all sessions for a given client (cross-session memory).
   * Returns the most recent turns ordered by time, useful for conversation continuity.
   */
  async getRecentTurnsByClient(clientId: string, limit = 10): Promise<Array<{ speaker: string; text: string; language: string }>> {
    const { rows } = await this.pool.query(
      `SELECT t.speaker, t.text, t.language
       FROM transcript_turns t
       JOIN sessions s ON t.session_id = s.id
       WHERE s.client_id = $1 AND t.status = 'complete'
       ORDER BY t.created_at DESC
       LIMIT $2`,
      [clientId, limit]
    );
    // Reverse to get chronological order
    return rows.reverse().map((r) => ({
      speaker: r.speaker,
      text: r.text,
      language: r.language,
    }));
  }

  async getConversationContext(sessionId: string): Promise<ConversationContext> {
    const [turns, actionsResult] = await Promise.all([
      this.getTurns(sessionId),
      this.pool.query('SELECT * FROM action_logs WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1', [sessionId]),
    ]);

    const lastUserTurn = [...turns].reverse().find((t) => t.speaker === 'user');
    const lastLanguage = lastUserTurn?.language ?? 'en-NG';
    const pendingAction = actionsResult.rows[0]
      ? this.rowToAction(actionsResult.rows[0])
      : undefined;

    return {
      sessionId,
      turns,
      referencedEntities: {},
      lastLanguage: lastLanguage as LanguageCode,
      pendingAction: pendingAction && pendingAction.status === 'pending' ? pendingAction : undefined,
      dialogueState: {
        awaitingConfirmation: pendingAction?.status === 'pending',
        slots: {},
        escalationActive: false,
      },
    };
  }

  async createAction(action: Omit<ActionLog, 'id' | 'createdAt'>): Promise<ActionLog> {
    const id = uuidv4();
    const { rows } = await this.pool.query(
      `INSERT INTO action_logs (id, session_id, turn_id, intent_name, action_name, parameters, status, confirming_turn_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        action.sessionId,
        action.turnId,
        action.intentName,
        action.actionName,
        JSON.stringify(action.parameters),
        action.status,
        action.confirmingTurnId ?? null,
      ]
    );
    return this.rowToAction(rows[0]);
  }

  async updateAction(actionId: string, updates: Partial<ActionLog>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;

    if (updates.status) { sets.push(`status = $${idx++}`); vals.push(updates.status); }
    if (updates.result) { sets.push(`result = $${idx++}`); vals.push(JSON.stringify(updates.result)); }
    if (updates.errorMessage) { sets.push(`error_message = $${idx++}`); vals.push(updates.errorMessage); }
    if (updates.confirmingTurnId) { sets.push(`confirming_turn_id = $${idx++}`); vals.push(updates.confirmingTurnId); }
    if (updates.executedAt) { sets.push(`executed_at = $${idx++}`); vals.push(updates.executedAt); }

    if (sets.length === 0) return;
    vals.push(actionId);
    await this.pool.query(
      `UPDATE action_logs SET ${sets.join(', ')} WHERE id = $${idx}`,
      vals
    );
  }

  async getActions(sessionId: string): Promise<ActionLog[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM action_logs WHERE session_id = $1 ORDER BY created_at ASC',
      [sessionId]
    );
    return rows.map((r) => this.rowToAction(r));
  }

  async getSessionSummary(sessionId: string): Promise<SessionSummary> {
    const session = await this.getSession(sessionId);
    const turns = await this.getTurns(sessionId);
    const actions = await this.getActions(sessionId);

    const languagesUsed = [...new Set(turns.map((t) => t.language))] as LanguageCode[];
    const escalated = session?.phase === 'escalated';
    const avgConfidence = turns.length > 0
      ? turns.reduce((sum, t) => sum + t.confidence, 0) / turns.length
      : 0;
    const durationMs = session?.endedAt
      ? session.endedAt.getTime() - session.startedAt.getTime()
      : Date.now() - session!.startedAt.getTime();

    return {
      sessionId,
      totalTurns: turns.length,
      languagesUsed,
      actionsTaken: actions.filter((a) => a.status === 'executed').length,
      escalated,
      durationMs,
      avgConfidence,
    };
  }

  async getTranscript(sessionId: string) {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const [turns, actions, summary] = await Promise.all([
      this.getTurns(sessionId),
      this.getActions(sessionId),
      this.getSessionSummary(sessionId),
    ]);

    return { session, turns, actions, summary };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      id: row['id'] as string,
      clientId: row['client_id'] as string,
      callerId: row['caller_id'] as string,
      callerPhone: row['caller_phone'] as string | undefined,
      phase: row['phase'] as SessionPhase,
      preferredLanguage: row['preferred_language'] as LanguageCode | undefined,
      metadata: row['metadata'] as Record<string, unknown>,
      startedAt: new Date(row['started_at'] as string),
      endedAt: row['ended_at'] ? new Date(row['ended_at'] as string) : undefined,
    };
  }

  private rowToTurn(row: Record<string, unknown>): TranscriptTurn {
    return {
      id: row['id'] as string,
      sessionId: row['session_id'] as string,
      turnIndex: row['turn_index'] as number,
      speaker: row['speaker'] as SpeakerRole,
      language: row['language'] as LanguageCode,
      text: row['text'] as string,
      englishTranslation: row['english_translation'] as string | undefined,
      status: row['status'] as TurnStatus,
      confidence: row['confidence'] as number,
      latencyMs: row['latency_ms'] as number | undefined,
      actionId: row['action_id'] as string | undefined,
      escalationReason: row['escalation_reason'] as EscalationReason | undefined,
      createdAt: new Date(row['created_at'] as string),
    };
  }

  private rowToAction(row: Record<string, unknown>): ActionLog {
    return {
      id: row['id'] as string,
      sessionId: row['session_id'] as string,
      turnId: row['turn_id'] as string,
      intentName: row['intent_name'] as string,
      actionName: row['action_name'] as string,
      parameters: row['parameters'] as Record<string, unknown>,
      status: row['status'] as ActionStatus,
      result: row['result'] as Record<string, unknown> | undefined,
      errorMessage: row['error_message'] as string | undefined,
      confirmingTurnId: row['confirming_turn_id'] as string | undefined,
      executedAt: row['executed_at'] ? new Date(row['executed_at'] as string) : undefined,
      createdAt: new Date(row['created_at'] as string),
    };
  }
}
