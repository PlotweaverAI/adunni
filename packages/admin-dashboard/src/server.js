import express from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '3007', 10);
const API_GATEWAY_URL = process.env.API_GATEWAY_URL ?? 'http://localhost:3000';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adunni:adunni_dev_pass@localhost:5432/adunni';

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

const app = express();
app.use(express.json());
app.use('/static', express.static(join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8'));
});

app.get('/api/dashboard-data', async (_req, res) => {
  try {
    const [
      volumeResult,
      activeResult,
      langResult,
      phaseResult,
      latencyResult,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM sessions'),
      pool.query("SELECT COUNT(*)::int AS count FROM sessions WHERE phase IN ('active', 'connecting')"),
      pool.query("SELECT language, COUNT(*)::int AS count FROM transcript_turns WHERE speaker = 'user' GROUP BY language"),
      pool.query("SELECT COUNT(*) FILTER (WHERE phase = 'ended')::int AS ended, COUNT(*) FILTER (WHERE phase = 'escalated')::int AS escalated, COUNT(*)::int AS total FROM sessions WHERE phase IN ('ended', 'escalated')"),
      pool.query('SELECT AVG(latency_ms)::float AS avg_latency FROM transcript_turns WHERE latency_ms IS NOT NULL'),
    ]);

    const langDist = { 'en-NG': 0, 'pcm': 0, 'yo': 0, 'ig': 0, 'ha': 0 };
    for (const row of langResult.rows) {
      if (row.language in langDist) langDist[row.language] = row.count;
    }

    const totalCompleted = phaseResult.rows[0].total || 0;
    const ended = phaseResult.rows[0].ended || 0;
    const escalated = phaseResult.rows[0].escalated || 0;

    const metrics = {
      callVolume: volumeResult.rows[0].count,
      languageDistribution: langDist,
      resolutionRate: totalCompleted > 0 ? Math.round((ended / totalCompleted) * 100) : 0,
      escalationRate: totalCompleted > 0 ? Math.round((escalated / totalCompleted) * 100) : 0,
      avgLatencyMs: latencyResult.rows[0].avg_latency ? Math.round(latencyResult.rows[0].avg_latency) : 0,
      activeSessions: activeResult.rows[0].count,
    };
    res.json({ metrics, apiGatewayUrl: API_GATEWAY_URL });
  } catch (err) {
    console.error('[dashboard] error:', err);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

app.listen(PORT, () => {
  console.log(`[admin-dashboard] listening on :${PORT}`);
});

process.on('SIGTERM', () => {
  pool.end();
  process.exit(0);
});
