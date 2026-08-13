import { Pool } from 'pg';
import type { Request, Response, NextFunction } from 'express';

export interface NdprConsent {
  sessionId: string;
  callerId: string;
  consentGiven: boolean;
  consentTimestamp: Date;
  consentVersion: string;
  retentionDays: number;
}

export class NdprComplianceService {
  private pool: Pool;
  private consentVersion: string;

  constructor(pool: Pool, consentVersion: string = '1.0') {
    this.pool = pool;
    this.consentVersion = consentVersion;
  }

  async recordConsent(sessionId: string, callerId: string, consentGiven: boolean, retentionDays: number = 90): Promise<NdprConsent> {
    const { rows } = await this.pool.query(
      `INSERT INTO audit_events (session_id, event_type, event_data, created_at)
       VALUES ($1, 'ndpr_consent', $2, NOW())
       RETURNING *`,
      [sessionId, JSON.stringify({ callerId, consentGiven, consentVersion: this.consentVersion, retentionDays })]
    );

    return {
      sessionId,
      callerId,
      consentGiven,
      consentTimestamp: new Date(rows[0]['created_at']),
      consentVersion: this.consentVersion,
      retentionDays,
    };
  }

  async checkConsent(sessionId: string): Promise<NdprConsent | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM audit_events WHERE session_id = $1 AND event_type = 'ndpr_consent' ORDER BY created_at DESC LIMIT 1`,
      [sessionId]
    );
    if (!rows[0]) return null;
    const data = rows[0]['event_data'];
    return {
      sessionId,
      callerId: data['callerId'],
      consentGiven: data['consentGiven'],
      consentTimestamp: new Date(rows[0]['created_at']),
      consentVersion: data['consentVersion'],
      retentionDays: data['retentionDays'],
    };
  }

  async enforceRetention(clientId: string): Promise<number> {
    const configResp = await this.pool.query(
      'SELECT transcript_retention_days, audio_retention_hrs FROM clients WHERE client_id = $1',
      [clientId]
    );
    if (!configResp.rows[0]) return 0;

    const retentionDays = configResp.rows[0]['transcript_retention_days'] ?? 90;

    const deleted = await this.pool.query(
      `DELETE FROM transcript_turns
       WHERE session_id IN (
         SELECT id FROM sessions WHERE client_id = $1 AND started_at < NOW() - make_interval(days => $2)
       )
       RETURNING id`,
      [clientId, retentionDays]
    );

    await this.pool.query(
      `DELETE FROM sessions WHERE client_id = $1 AND started_at < NOW() - make_interval(days => $2)`,
      [clientId, retentionDays]
    );

    return deleted.rowCount ?? 0;
  }

  async rightToErasure(callerId: string, clientId: string): Promise<{ sessionsDeleted: number; turnsDeleted: number; actionsDeleted: number }> {
    const sessionsResult = await this.pool.query(
      'DELETE FROM sessions WHERE caller_id = $1 AND client_id = $2 RETURNING id',
      [callerId, clientId]
    );
    const sessionIds = sessionsResult.rows.map((r) => r['id']);

    if (sessionIds.length === 0) {
      return { sessionsDeleted: 0, turnsDeleted: 0, actionsDeleted: 0 };
    }

    const turnsResult = await this.pool.query(
      'DELETE FROM transcript_turns WHERE session_id = ANY($1) RETURNING id',
      [sessionIds]
    );
    const actionsResult = await this.pool.query(
      'DELETE FROM action_logs WHERE session_id = ANY($1) RETURNING id',
      [sessionIds]
    );

    await this.pool.query(
      `INSERT INTO audit_events (session_id, event_type, event_data, created_at)
       VALUES (NULL, 'ndpr_erasure_request', $1, NOW())`,
      [JSON.stringify({ callerId, clientId, sessionsDeleted: sessionIds.length, timestamp: new Date().toISOString() })]
    );

    return {
      sessionsDeleted: sessionIds.length,
      turnsDeleted: turnsResult.rowCount ?? 0,
      actionsDeleted: actionsResult.rowCount ?? 0,
    };
  }

  async dataPortability(callerId: string, clientId: string): Promise<Record<string, unknown>> {
    const sessions = await this.pool.query(
      'SELECT * FROM sessions WHERE caller_id = $1 AND client_id = $2 ORDER BY created_at DESC',
      [callerId, clientId]
    );
    const sessionIds = sessions.rows.map((r) => r['id']);

    const turns = sessionIds.length > 0
      ? await this.pool.query('SELECT * FROM transcript_turns WHERE session_id = ANY($1) ORDER BY turn_index', [sessionIds])
      : { rows: [] };

    const actions = sessionIds.length > 0
      ? await this.pool.query('SELECT * FROM action_logs WHERE session_id = ANY($1) ORDER BY created_at', [sessionIds])
      : { rows: [] };

    return {
      callerId,
      clientId,
      exportedAt: new Date().toISOString(),
      sessions: sessions.rows,
      transcriptTurns: turns.rows,
      actionLogs: actions.rows,
    };
  }
}

export function consentMiddleware(service: NdprComplianceService) {
  return async (req: Request & { auth?: { clientId: string } }, res: Response, next: NextFunction) => {
    const sessionId = req.params['sessionId'] ?? req.body['sessionId'];
    if (!sessionId) return next();

    const consent = await service.checkConsent(sessionId);
    if (consent && !consent.consentGiven) {
      return res.status(403).json({ error: 'Caller did not provide NDPR consent. Data processing is not permitted.' });
    }
    next();
  };
}
