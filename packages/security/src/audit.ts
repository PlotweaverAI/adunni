import { Pool } from 'pg';
import type { AuthenticatedRequest } from './rbac.js';

export type AuditEventType =
  | 'session_start'
  | 'session_end'
  | 'transcript_read'
  | 'config_update'
  | 'action_execute'
  | 'action_confirm'
  | 'escalation'
  | 'ndpr_consent'
  | 'ndpr_erasure_request'
  | 'data_export'
  | 'auth_failure'
  | 'rate_limit_hit'
  | 'webhook_subscribe';

export interface AuditEvent {
  id?: string;
  sessionId?: string;
  clientId?: string;
  actorId?: string;
  actorRole?: string;
  eventType: AuditEventType;
  eventData?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt?: Date;
}

export class AuditLogger {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async log(event: AuditEvent): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO audit_events (session_id, event_type, event_data, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [
          event.sessionId ?? null,
          event.eventType,
          JSON.stringify({
            clientId: event.clientId,
            actorId: event.actorId,
            actorRole: event.actorRole,
            ipAddress: event.ipAddress,
            userAgent: event.userAgent,
            ...event.eventData,
          }),
        ]
      );
    } catch (err) {
      console.error('[audit] Failed to log event:', err);
    }
  }

  logFromRequest(
    req: AuthenticatedRequest,
    eventType: AuditEventType,
    eventData?: Record<string, unknown>
  ): Promise<void> {
    return this.log({
      sessionId: req.params['sessionId'] ?? req.body['sessionId'],
      clientId: req.auth?.clientId,
      actorId: req.auth?.userId ?? req.auth?.clientId,
      actorRole: req.auth?.role,
      eventType,
      eventData,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  async query(filter: {
    clientId?: string;
    sessionId?: string;
    eventType?: AuditEventType;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<AuditEvent[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filter.clientId) {
      conditions.push(`event_data->>'clientId' = $${paramIdx++}`);
      params.push(filter.clientId);
    }
    if (filter.sessionId) {
      conditions.push(`session_id = $${paramIdx++}`);
      params.push(filter.sessionId);
    }
    if (filter.eventType) {
      conditions.push(`event_type = $${paramIdx++}`);
      params.push(filter.eventType);
    }
    if (filter.from) {
      conditions.push(`created_at >= $${paramIdx++}`);
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push(`created_at <= $${paramIdx++}`);
      params.push(filter.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;

    const { rows } = await this.pool.query(
      `SELECT * FROM audit_events ${where} ORDER BY created_at DESC LIMIT ${limit}`,
      params
    );

    return rows.map((r) => ({
      id: r['id'],
      sessionId: r['session_id'],
      eventType: r['event_type'] as AuditEventType,
      eventData: r['event_data'],
      createdAt: new Date(r['created_at']),
    }));
  }
}
