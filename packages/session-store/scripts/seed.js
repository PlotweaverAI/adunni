#!/usr/bin/env node
/**
 * Àdùnní — Database seed script (standalone, no TypeScript compilation required)
 *
 * Creates the Savanna Bank pilot client with intents, escalation rules, branding,
 * and admin/client API keys.
 *
 * Usage:
 *   DATABASE_URL=postgres://... ENCRYPTION_KEY=... node packages/session-store/scripts/seed.js
 */
const crypto = require('crypto');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://adunni:adunni_dev_pass@localhost:5432/adunni';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'dev_encryption_key_change_in_production';

// Mirror of EncryptionService from @adunni/security
function deriveKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}
const KEY = deriveKey(ENCRYPTION_KEY);

function hashPii(value) {
  return crypto.createHmac('sha256', KEY).update(value).digest('hex');
}
function generateApiKey() {
  return `adk_${crypto.randomBytes(32).toString('hex')}`;
}

const savannaBank = {
  clientId: 'savanna-bank',
  clientName: 'Savanna Bank',
  allowedLanguages: ['en-NG', 'pcm', 'yo', 'ig', 'ha'],
  defaultLanguage: 'en-NG',
  voicePersona: {
    name: 'Àdùnní',
    ttsVoiceId: 'adunni-yo-04',
    ttsProvider: 'commercial',
    speakingRate: 1.0,
    pitch: 0,
  },
  intents: [
    {
      name: 'check_balance',
      description: 'Check the caller account balance',
      utteranceExamples: [
        'What is my balance?',
        'How much do I have in my account?',
        'Ẹ jọ̀wọ́, iye owó tó wà nínú àkántì mi?',
      ],
      actionName: 'get_balance',
      requiredSlots: ['account_id'],
      requiresConfirmation: false,
      escalationOnFailure: true,
    },
    {
      name: 'transfer_status',
      description: 'Check the status of a pending transfer',
      utteranceExamples: [
        'Has my transfer gone through?',
        'Where is my money?',
        'Ṣé owó náà ti kúrò?',
      ],
      actionName: 'get_transfer_status',
      requiredSlots: ['transfer_id'],
      requiresConfirmation: false,
      escalationOnFailure: true,
    },
    {
      name: 'raise_transfer_limit',
      description: 'Raise the daily transfer limit for the caller',
      utteranceExamples: [
        'Please increase my transfer limit',
        'Make I raise my limit',
        'I want to send more than my limit allows',
      ],
      actionName: 'update_transfer_limit',
      requiredSlots: ['account_id', 'new_limit'],
      requiresConfirmation: true,
      escalationOnFailure: true,
    },
  ],
  escalationRules: {
    confidenceThreshold: 0.65,
    maxRetries: 2,
    handoffMode: 'explicit_message',
    handoffMessage: 'Let me connect you to a human agent who can help further.',
  },
  branding: {
    primaryColor: '#2FD4C4',
    secondaryColor: '#E4573C',
    agentName: 'Àdùnní',
    agentSubtitle: 'AI Banking Agent · Savanna Bank',
  },
  webhookUrl: 'https://api.savannabank.example/webhooks/adunni',
  webhookSecret: 'savanna_webhook_secret_dev',
  ndprConsentMessage: 'This call may be recorded for quality and training purposes. Your data is protected under NDPR.',
  audioRetentionHours: 24,
  transcriptRetentionDays: 90,
};

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });

  await pool.query(
    `INSERT INTO clients (client_id, client_name, allowed_languages, default_language, voice_persona, intents, escalation_rules, branding, webhook_url, webhook_secret, ndpr_consent_msg, audio_retention_hrs, transcript_retention_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (client_id) DO UPDATE SET
       client_name = EXCLUDED.client_name,
       allowed_languages = EXCLUDED.allowed_languages,
       default_language = EXCLUDED.default_language,
       voice_persona = EXCLUDED.voice_persona,
       intents = EXCLUDED.intents,
       escalation_rules = EXCLUDED.escalation_rules,
       branding = EXCLUDED.branding,
       webhook_url = EXCLUDED.webhook_url,
       webhook_secret = EXCLUDED.webhook_secret,
       ndpr_consent_msg = EXCLUDED.ndpr_consent_msg,
       audio_retention_hrs = EXCLUDED.audio_retention_hrs,
       transcript_retention_days = EXCLUDED.transcript_retention_days,
       updated_at = NOW()`,
    [
      savannaBank.clientId,
      savannaBank.clientName,
      savannaBank.allowedLanguages,
      savannaBank.defaultLanguage,
      JSON.stringify(savannaBank.voicePersona),
      JSON.stringify(savannaBank.intents),
      JSON.stringify(savannaBank.escalationRules),
      JSON.stringify(savannaBank.branding),
      savannaBank.webhookUrl,
      savannaBank.webhookSecret,
      savannaBank.ndprConsentMessage,
      savannaBank.audioRetentionHours,
      savannaBank.transcriptRetentionDays,
    ]
  );

  console.log('[seed] Inserted/updated client: savanna-bank');

  const adminKey = generateApiKey();
  const adminKeyHash = hashPii(adminKey);
  const clientKey = generateApiKey();
  const clientKeyHash = hashPii(clientKey);

  await pool.query(
    `INSERT INTO api_keys (client_id, key_hash, key_prefix, role, created_by)
     VALUES ($1, $2, $3, 'admin', 'seed')
     ON CONFLICT (key_hash) DO NOTHING`,
    ['savanna-bank', adminKeyHash, adminKey.slice(0, 8)]
  );

  await pool.query(
    `INSERT INTO api_keys (client_id, key_hash, key_prefix, role, created_by)
     VALUES ($1, $2, $3, 'client', 'seed')
     ON CONFLICT (key_hash) DO NOTHING`,
    ['savanna-bank', clientKeyHash, clientKey.slice(0, 8)]
  );

  console.log('[seed] Admin API key:  ', adminKey);
  console.log('[seed] Client API key:', clientKey);
  console.log('[seed] Use these keys with POST /v1/auth/token to get JWT tokens');

  await pool.end();
}

main().catch((err) => {
  console.error('[seed] Error:', err);
  process.exit(1);
});
