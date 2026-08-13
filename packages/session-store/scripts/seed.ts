import { SessionStore } from '../src/session-store.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adunni:adunni_dev_pass@localhost:5432/adunni';

async function main() {
  const store = new SessionStore(DATABASE_URL);

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
      handoffMode: 'explicit_message' as const,
      handoffMessage: "Let me connect you to a human agent who can help further.",
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

  const { Pool } = await import('pg');
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
  await pool.end();
  await store.close();
}

main().catch((err) => {
  console.error('[seed] Error:', err);
  process.exit(1);
});
