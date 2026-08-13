import express from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '3007', 10);
const API_GATEWAY_URL = process.env.API_GATEWAY_URL ?? 'http://localhost:3000';

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
    const metrics = {
      callVolume: 0,
      languageDistribution: { 'en-NG': 0, 'pcm': 0, 'yo': 0, 'ig': 0, 'ha': 0 },
      resolutionRate: 0,
      escalationRate: 0,
      avgLatencyMs: 0,
      activeSessions: 0,
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
