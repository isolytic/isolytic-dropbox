import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function createDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'vault-compare.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_pending (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY, project_name TEXT NOT NULL, local_path TEXT NOT NULL, remote_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', phase TEXT NOT NULL DEFAULT 'queued', resumed INTEGER NOT NULL DEFAULT 0,
      local_items INTEGER NOT NULL DEFAULT 0, local_bytes INTEGER NOT NULL DEFAULT 0,
      remote_items INTEGER NOT NULL DEFAULT 0, remote_bytes INTEGER NOT NULL DEFAULT 0,
      local_done INTEGER NOT NULL DEFAULT 0, remote_done INTEGER NOT NULL DEFAULT 0,
      remote_cursor TEXT, started_at TEXT, completed_at TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS inventory (
      scan_id INTEGER NOT NULL, side TEXT NOT NULL, path_key TEXT NOT NULL, display_path TEXT NOT NULL,
      kind TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (scan_id, side, path_key)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS inventory_scan_side ON inventory(scan_id, side);
    CREATE TABLE IF NOT EXISTS discrepancies (
      id INTEGER PRIMARY KEY, scan_id INTEGER NOT NULL, category TEXT NOT NULL, path TEXT NOT NULL,
      local_kind TEXT, remote_kind TEXT, local_size INTEGER, remote_size INTEGER
    );
    CREATE INDEX IF NOT EXISTS discrepancies_scan_category ON discrepancies(scan_id, category);
  `);
  // Safe migration for databases created by an earlier app version.
  try { db.exec('ALTER TABLE scans ADD COLUMN remote_only INTEGER NOT NULL DEFAULT 0'); } catch { /* already present */ }
  const api = {
    raw: db,
    getSetting(key) { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value; },
    setSetting(key, value) { db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); },
    deleteSetting(key) { db.prepare('DELETE FROM settings WHERE key=?').run(key); }
  };
  return api;
}
