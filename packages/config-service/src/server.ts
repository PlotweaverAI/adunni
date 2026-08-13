import express from 'express';
import { Pool } from 'pg';
import type { ClientConfig, LanguageCode } from '@adunni/shared-types';

const PORT = parseInt(process.env.PORT ?? '3005', 10);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adunni:adunni_dev_pass@localhost:5432/adunni';

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/clients/:clientId/config', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clients WHERE client_id = $1', [req.params.clientId]);
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json(rowToConfig(rows[0]));
  } catch (err) {
    console.error('[config] get error:', err);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

app.post('/clients/:clientId/config', async (req, res) => {
  try {
    const config = req.body as Partial<ClientConfig>;
    const clientId = req.params.clientId;

    const { rows } = await pool.query(
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
         updated_at = NOW()
       RETURNING *`,
      [
        clientId,
        config.clientName ?? clientId,
        config.allowedLanguages ?? ['en-NG', 'pcm', 'yo', 'ig', 'ha'],
        config.defaultLanguage ?? 'en-NG',
        JSON.stringify(config.voicePersona ?? { name: 'Agent', ttsVoiceId: 'default', ttsProvider: 'commercial', speakingRate: 1, pitch: 0 }),
        JSON.stringify(config.intents ?? []),
        JSON.stringify(config.escalationRules ?? { confidenceThreshold: 0.65, maxRetries: 2, handoffMode: 'explicit_message' }),
        JSON.stringify(config.branding ?? null),
        config.webhookUrl ?? null,
        config.webhookSecret ?? null,
        config.ndprConsentMessage ?? 'This call may be recorded for quality and training purposes.',
        config.audioRetentionHours ?? 24,
        config.transcriptRetentionDays ?? 90,
      ]
    );
    res.status(201).json(rowToConfig(rows[0]));
  } catch (err) {
    console.error('[config] upsert error:', err);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

app.get('/clients', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT client_id, client_name, created_at FROM clients ORDER BY created_at DESC');
    res.json(rows.map((r) => ({ clientId: r['client_id'], clientName: r['client_name'], createdAt: r['created_at'] })));
  } catch (err) {
    console.error('[config] list error:', err);
    res.status(500).json({ error: 'Failed to list clients' });
  }
});

function rowToConfig(row: Record<string, unknown>): ClientConfig {
  return {
    clientId: row['client_id'] as string,
    clientName: row['client_name'] as string,
    allowedLanguages: row['allowed_languages'] as LanguageCode[],
    defaultLanguage: row['default_language'] as LanguageCode,
    voicePersona: row['voice_persona'] as ClientConfig['voicePersona'],
    intents: row['intents'] as ClientConfig['intents'],
    escalationRules: row['escalation_rules'] as ClientConfig['escalationRules'],
    branding: row['branding'] as ClientConfig['branding'] | undefined,
    webhookUrl: row['webhook_url'] as string | undefined,
    webhookSecret: row['webhook_secret'] as string | undefined,
    ndprConsentMessage: row['ndpr_consent_msg'] as string,
    audioRetentionHours: row['audio_retention_hrs'] as number,
    transcriptRetentionDays: row['transcript_retention_days'] as number,
    createdAt: new Date(row['created_at'] as string),
    updatedAt: new Date(row['updated_at'] as string),
  };
}

app.listen(PORT, () => {
  console.log(`[config-service] listening on :${PORT}`);
});

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});
