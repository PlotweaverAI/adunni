import type {
  ActionExecutorService,
  ActionRequest,
  ActionResult,
  ActionLog,
  ActionStatus,
  WebhookPayload,
} from '@adunni/shared-types';
import { Pool } from 'pg';
import crypto from 'crypto';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_CALLS = 10;

export class ActionExecutorServiceImpl implements ActionExecutorService {
  private pool: Pool;
  private rateLimitMap: Map<string, number[]> = new Map();

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    const allowed = await this.rateLimitCheck(request.sessionId, request.actionName);
    if (!allowed) {
      return {
        actionId: request.actionId,
        status: 'failed' as ActionStatus,
        errorMessage: 'Rate limit exceeded for this action',
      };
    }

    try {
      const payload: WebhookPayload = {
        sessionId: request.sessionId,
        clientId: request.clientId,
        actionName: request.actionName,
        parameters: request.parameters,
        timestamp: new Date(),
      };

      const response = await this.callWebhook(request.webhookUrl, request.webhookSecret, payload);

      const result: ActionResult = {
        actionId: request.actionId,
        status: 'executed' as ActionStatus,
        result: response,
        executedAt: new Date(),
      };

      await this.pool.query(
        'UPDATE action_logs SET status = $1, result = $2, executed_at = NOW() WHERE id = $3',
        ['executed', JSON.stringify(response), request.actionId]
      );

      return result;
    } catch (err) {
      const errorMessage = (err as Error).message;
      await this.pool.query(
        'UPDATE action_logs SET status = $1, error_message = $2 WHERE id = $3',
        ['failed', errorMessage, request.actionId]
      );

      return {
        actionId: request.actionId,
        status: 'failed' as ActionStatus,
        errorMessage,
      };
    }
  }

  async confirm(actionId: string, confirmed: boolean): Promise<ActionResult> {
    if (confirmed) {
      await this.pool.query(
        'UPDATE action_logs SET status = $1 WHERE id = $2',
        ['confirmed', actionId]
      );
      return { actionId, status: 'confirmed' as ActionStatus };
    } else {
      await this.pool.query(
        'UPDATE action_logs SET status = $1 WHERE id = $2',
        ['denied', actionId]
      );
      return { actionId, status: 'denied' as ActionStatus };
    }
  }

  async getAction(actionId: string): Promise<ActionLog | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM action_logs WHERE id = $1',
      [actionId]
    );
    if (!rows[0]) return null;
    const row = rows[0];
    return {
      id: row['id'],
      sessionId: row['session_id'],
      turnId: row['turn_id'],
      intentName: row['intent_name'],
      actionName: row['action_name'],
      parameters: row['parameters'],
      status: row['status'] as ActionStatus,
      result: row['result'],
      errorMessage: row['error_message'],
      confirmingTurnId: row['confirming_turn_id'],
      executedAt: row['executed_at'] ? new Date(row['executed_at']) : undefined,
      createdAt: new Date(row['created_at']),
    };
  }

  async rateLimitCheck(sessionId: string, actionName: string): Promise<boolean> {
    const key = `${sessionId}:${actionName}`;
    const now = Date.now();
    const timestamps = this.rateLimitMap.get(key) ?? [];
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

    if (recent.length >= RATE_LIMIT_MAX_CALLS) {
      return false;
    }

    recent.push(now);
    this.rateLimitMap.set(key, recent);
    return true;
  }

  private async callWebhook(
    url: string,
    secret: string,
    payload: WebhookPayload
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Adunni-Signature': `sha256=${signature}`,
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<Record<string, unknown>>;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
