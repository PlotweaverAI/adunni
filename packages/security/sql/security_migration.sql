-- Security schema additions for NDPR compliance and audit logging
-- Extends the base init.sql with additional columns and indexes

-- Add PII encryption columns to sessions
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS caller_phone_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS caller_phone_hash TEXT;

-- Add PII encryption columns to transcript_turns
ALTER TABLE transcript_turns
  ADD COLUMN IF NOT EXISTS text_encrypted TEXT;

-- Add NDPR consent tracking to sessions
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS ndpr_consent_given BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ndpr_consent_timestamp TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ndpr_consent_version TEXT;

-- Add retention enforcement tracking
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS retention_expires_at TIMESTAMPTZ
  GENERATED ALWAYS AS (
    started_at + INTERVAL '90 days'
  ) STORED;

-- Indexes for audit queries
CREATE INDEX IF NOT EXISTS idx_audit_events_session_id ON audit_events (session_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_event_type ON audit_events (event_type);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events (created_at DESC);

-- Index for NDPR erasure queries
CREATE INDEX IF NOT EXISTS idx_sessions_caller_id_client_id ON sessions (caller_id, client_id);

-- Index for retention enforcement
CREATE INDEX IF NOT EXISTS idx_sessions_retention_expires ON sessions (retention_expires_at)
  WHERE ended_at IS NOT NULL;

-- Index for transcript cleanup
CREATE INDEX IF NOT EXISTS idx_transcript_turns_session_id ON transcript_turns (session_id);

-- Add API key storage for client authentication
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('admin', 'operator', 'client')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_client_id ON api_keys (client_id) WHERE revoked_at IS NULL;
