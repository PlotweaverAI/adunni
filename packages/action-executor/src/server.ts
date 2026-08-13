import express from 'express';
import { ActionExecutorServiceImpl } from './action-executor-service.js';
import type { ActionRequest } from '@adunni/shared-types';

const PORT = parseInt(process.env.PORT ?? '3004', 10);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adunni:adunni_dev_pass@localhost:5432/adunni';

const executor = new ActionExecutorServiceImpl(DATABASE_URL);
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/execute', async (req, res) => {
  try {
    const request = req.body as ActionRequest;
    if (!request.actionId || !request.actionName) {
      return res.status(400).json({ error: 'actionId and actionName are required' });
    }
    const result = await executor.execute(request);
    res.json(result);
  } catch (err) {
    console.error('[action-executor] execute error:', err);
    res.status(500).json({ error: 'Action execution failed' });
  }
});

app.post('/confirm', async (req, res) => {
  try {
    const { actionId, confirmed } = req.body;
    if (!actionId) return res.status(400).json({ error: 'actionId is required' });
    const result = await executor.confirm(actionId, confirmed ?? false);
    res.json(result);
  } catch (err) {
    console.error('[action-executor] confirm error:', err);
    res.status(500).json({ error: 'Confirmation failed' });
  }
});

app.get('/actions/:actionId', async (req, res) => {
  try {
    const action = await executor.getAction(req.params.actionId);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    res.json(action);
  } catch (err) {
    console.error('[action-executor] getAction error:', err);
    res.status(500).json({ error: 'Failed to get action' });
  }
});

app.listen(PORT, () => {
  console.log(`[action-executor] listening on :${PORT}`);
});

process.on('SIGTERM', async () => {
  await executor.close();
  process.exit(0);
});
