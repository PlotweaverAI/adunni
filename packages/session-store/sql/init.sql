-- Àdùnní — Database Schema v0.1
-- Session, transcript, action log, and client config tables

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Clients ──
CREATE TABLE IF NOT EXISTS clients (
  client_id          TEXT PRIMARY KEY,
  client_name        TEXT NOT NULL,
  allowed_languages  TEXT[] NOT NULL DEFAULT '{en-NG,pcm,yo,ig,ha}',
  default_language   TEXT NOT NULL DEFAULT 'en-NG',
  voice_persona      JSONB NOT NULL,
  intents            JSONB NOT NULL DEFAULT '[]',
  escalation_rules   JSONB NOT NULL,
  branding           JSONB,
  webhook_url        TEXT,
  webhook_secret     TEXT,
  ndpr_consent_msg   TEXT NOT NULL DEFAULT 'This call may be recorded for quality and training purposes.',
  audio_retention_hrs    INTEGER NOT NULL DEFAULT 24,
  transcript_retention_days INTEGER NOT NULL DEFAULT 90,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Sessions ──
CREATE TABLE IF NOT EXISTS sessions (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id          TEXT NOT NULL REFERENCES clients(client_id),
  caller_id          TEXT NOT NULL,
  caller_phone       TEXT,
  phase              TEXT NOT NULL DEFAULT 'idle',
  preferred_language TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}',
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at           TIMESTAMPTZ
);

CREATE INDEX idx_sessions_client ON sessions(client_id);
CREATE INDEX idx_sessions_phase ON sessions(phase);
CREATE INDEX idx_sessions_started ON sessions(started_at DESC);

-- ── Transcript Turns ──
CREATE TABLE IF NOT EXISTS transcript_turns (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id         UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_index         INTEGER NOT NULL,
  speaker            TEXT NOT NULL CHECK (speaker IN ('ai', 'user')),
  language           TEXT NOT NULL,
  text               TEXT NOT NULL,
  english_translation TEXT,
  status             TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('transcribing', 'complete', 'error')),
  confidence         REAL NOT NULL DEFAULT 1.0,
  latency_ms         INTEGER,
  action_id          UUID,
  escalation_reason  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_turns_session ON transcript_turns(session_id, turn_index);

-- ── Action Logs ──
CREATE TABLE IF NOT EXISTS action_logs (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id         UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id            UUID NOT NULL REFERENCES transcript_turns(id) ON DELETE CASCADE,
  intent_name        TEXT NOT NULL,
  action_name        TEXT NOT NULL,
  parameters         JSONB NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'executed', 'failed', 'denied')),
  result             JSONB,
  error_message      TEXT,
  confirming_turn_id UUID,
  executed_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_actions_session ON action_logs(session_id);
CREATE INDEX idx_actions_status ON action_logs(status);

-- ── Audit Trail ──
CREATE TABLE IF NOT EXISTS audit_events (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id         UUID REFERENCES sessions(id) ON DELETE CASCADE,
  client_id          TEXT,
  event_type         TEXT NOT NULL,
  event_data         JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_session ON audit_events(session_id);
CREATE INDEX idx_audit_client ON audit_events(client_id, created_at DESC);

-- ── Webhook Subscriptions ──
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id          TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  url                TEXT NOT NULL,
  secret             TEXT,
  events             TEXT[] NOT NULL DEFAULT '{turn.complete,action.executed,session.ended,session.escalated}',
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhooks_client ON webhook_subscriptions(client_id, active);
