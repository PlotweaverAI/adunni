import type { ActionStatus } from './enums.js';
import type { ActionLog } from './models.js';

export interface ActionRequest {
  actionId: string;
  sessionId: string;
  clientId: string;
  intentName: string;
  actionName: string;
  parameters: Record<string, unknown>;
  webhookUrl: string;
  webhookSecret: string;
}

export interface ActionResult {
  actionId: string;
  status: ActionStatus;
  result?: Record<string, unknown>;
  errorMessage?: string;
  executedAt?: Date;
}

export interface ActionExecutorService {
  execute: (request: ActionRequest) => Promise<ActionResult>;
  confirm: (actionId: string, confirmed: boolean) => Promise<ActionResult>;
  getAction: (actionId: string) => Promise<ActionLog | null>;
  rateLimitCheck: (sessionId: string, actionName: string) => Promise<boolean>;
}

export interface WebhookPayload {
  sessionId: string;
  clientId: string;
  actionName: string;
  parameters: Record<string, unknown>;
  timestamp: Date;
}
