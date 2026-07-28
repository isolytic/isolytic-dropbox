import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './store.js';
import { ScanQueue } from './scanner.js';
import { DropboxClient } from './dropbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const vaultRoot = process.env.VAULT_ROOT || '/vault';
const dataDir = process.env.DATA_DIR || '/data';
const db = createDb(dataDir);
const dropbox = new DropboxClient(db);
const scans = new ScanQueue({ db, dropbox, vaultRoot });

app.use(express.json({ limit: '1mb' }));

app.get('/api/status', async (_req, res) => {
  res.json({ configured: Boolean(db.getSetting('dropbox_app_key') && db.getSetting('dropbox_access_token')), vaultRoot, connected: Boolean(db.getSetting('dropbox_access_token')) });
});

app.get('/api/settings', (_req, res) => res.json({
  appKey: db.getSetting('dropbox_app_key') || '',
  remoteRoot: db.getSetting('dropbox_remote_root') || '',
  historyLimit: Number(db.getSetting('history_limit') || 5),
  connected: Boolean(db.getSetting('dropbox_access_token')),
  vaultRoot
}));

app.put('/api/settings', (req, res) => {
  const { appKey, remoteRoot, historyLimit } = req.body;
  if (typeof appKey === 'string') db.setSetting('dropbox_app_key', appKey.trim());
  if (typeof remoteRoot === 'string') db.setSetting('dropbox_remote_root', normalizeRemote(remoteRoot));
  if (Number.isInteger(historyLimit) && historyLimit >= 1 && historyLimit <= 100) db.setSetting('history_limit', String(historyLimit));
  res.json({ ok: true });
});

app.get('/api/auth/dropbox/start', (req, res) => {
  const appKey = db.getSetting('dropbox_app_key');
  if (!appKey) return res.status(400).json({ error: 'Save your Dropbox App Key first.' });
  const redirectUri = `${requestOrigin(req)}/api/auth/dropbox/callback`;
  const url = dropbox.beginAuth({ appKey, redirectUri });
  res.json({ url });
});

app.get('/api/auth/dropbox/callback', async (req, res) => {
  try {
    await dropbox.completeAuth({ code: req.query.code, state: req.query.state, redirectUri: `${requestOrigin(req)}/api/auth/dropbox/callback` });
    res.redirect('/?dropbox=connected');
  } catch (error) {
    console.warn(`Dropbox OAuth callback failed: ${error.message}`);
    res.redirect(`/?dropbox=error&message=${encodeURIComponent(error.message)}`);
  }
});

app.get('/api/projects', async (_req, res) => {
  try { res.json(await scans.projects()); } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/scans', (_req, res) => res.json(scans.list()));
app.get('/api/scans/:id/discrepancies', (req, res) => res.json(scans.discrepancies(Number(req.params.id), req.query)));
app.post('/api/scans', async (req, res) => {
  try { res.status(202).json(await scans.enqueue(req.body.projectNames)); } catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/scans/:id/retry', async (req, res) => {
  try { res.status(202).json(await scans.retry(Number(req.params.id))); } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/connection/export', (_req, res) => {
  const payload = { version: 1, appKey: db.getSetting('dropbox_app_key'), remoteRoot: db.getSetting('dropbox_remote_root'), accessToken: db.getSetting('dropbox_access_token'), refreshToken: db.getSetting('dropbox_refresh_token') };
  res.json({ bundle: Buffer.from(JSON.stringify(payload)).toString('base64url') });
});
app.post('/api/connection/import', (req, res) => {
  try {
    const data = JSON.parse(Buffer.from(req.body.bundle, 'base64url').toString());
    if (data.version !== 1 || !data.appKey || !data.accessToken) throw new Error('Not a valid connection bundle.');
    for (const [key, value] of Object.entries({ dropbox_app_key: data.appKey, dropbox_remote_root: data.remoteRoot || '', dropbox_access_token: data.accessToken, dropbox_refresh_token: data.refreshToken || '' })) db.setSetting(key, value);
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get('*splat', (_req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')));

function requestOrigin(req) { return `${req.protocol}://${req.get('host')}`; }
function normalizeRemote(value) { const clean = value.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''); return clean ? `/${clean}` : ''; }

app.listen(port, () => console.log(`Vault Compare listening on ${port}`));
scans.resume();
