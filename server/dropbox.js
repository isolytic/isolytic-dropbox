import crypto from 'node:crypto';

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API_URL = 'https://api.dropboxapi.com/2';

export class DropboxClient {
  constructor(db) { this.db = db; }
  beginAuth({ appKey, redirectUri }) {
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    this.db.raw.prepare('INSERT INTO oauth_pending(state,verifier,redirect_uri,created_at) VALUES (?,?,?,?)').run(state, verifier, redirectUri, new Date().toISOString());
    const q = new URLSearchParams({ client_id: appKey, response_type: 'code', redirect_uri: redirectUri, state, token_access_type: 'offline', code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
    return `${AUTH_URL}?${q}`;
  }
  async completeAuth({ code, state, redirectUri }) {
    const pending = this.db.raw.prepare('SELECT * FROM oauth_pending WHERE state=?').get(state);
    this.db.raw.prepare('DELETE FROM oauth_pending WHERE state=?').run(state);
    if (!code || !pending || pending.redirect_uri !== redirectUri) throw new Error('The Dropbox login request expired or did not match this app. Please try again.');
    // Dropbox PKCE exchanges identify the request with code_verifier, not a client secret.
    const body = new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: pending.verifier });
    const response = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error_description || 'Dropbox did not accept the authorization code.');
    this.db.setSetting('dropbox_access_token', data.access_token);
    if (data.refresh_token) this.db.setSetting('dropbox_refresh_token', data.refresh_token);
  }
  async api(endpoint, payload) {
    let refreshed = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      let response = await this.request(endpoint, payload);
      if (response.status === 401 && !refreshed && this.db.getSetting('dropbox_refresh_token')) { await this.refresh(); refreshed = true; response = await this.request(endpoint, payload); }
      if (response.status === 429 || response.status >= 500) {
        const retry = Number(response.headers.get('retry-after'));
        const seconds = Number.isFinite(retry) && retry > 0 ? retry : Math.min(60, 2 ** attempt);
        await delay(seconds * 1000);
        continue;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error_summary || `Dropbox API error (${response.status})`);
      return data;
    }
    throw new Error('Dropbox remained unavailable after several retries.');
  }
  async request(endpoint, payload) { return fetch(`${API_URL}${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${this.db.getSetting('dropbox_access_token')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
  async refresh() {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.db.getSetting('dropbox_refresh_token'), client_id: this.db.getSetting('dropbox_app_key') });
    const response = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error_description || 'Dropbox refresh failed. Reconnect Dropbox in Settings.');
    this.db.setSetting('dropbox_access_token', data.access_token);
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
