import fs from 'node:fs/promises';
import path from 'node:path';

class ScanPaused extends Error { constructor() { super('Scan paused'); } }

export class ScanQueue {
  constructor({ db, dropbox, vaultRoot }) { this.db = db; this.dropbox = dropbox; this.vaultRoot = vaultRoot; this.running = false; }
  async projects() {
    const entries = await fs.readdir(this.vaultRoot, { withFileTypes: true });
    const remoteRoot = this.db.getSetting('dropbox_remote_root') || '';
    return entries.filter(x => x.isDirectory() && !x.isSymbolicLink()).map(x => ({ name: x.name, localPath: path.join(this.vaultRoot, x.name), remotePath: `${remoteRoot}/${x.name}`.replace(/\/+/g, '/') }));
  }
  list() {
    return this.db.raw.prepare(`SELECT s.*, (SELECT COUNT(*) FROM discrepancies d WHERE d.scan_id=s.id) discrepancy_count,
      (SELECT COUNT(*) FROM discrepancies d WHERE d.scan_id=s.id AND d.category='additional_in_dropbox') additional_in_dropbox
      FROM scans s WHERE s.id IN (SELECT MAX(id) FROM scans GROUP BY project_name)
      ORDER BY CASE s.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'incomplete' THEN 2 ELSE 3 END, s.project_name`).all();
  }
  discrepancies(id, query) {
    const page = Math.max(0, Number(query.page || 0)); const limit = Math.min(500, Math.max(25, Number(query.limit || 100)));
    const category = query.category ? ' AND category = ?' : ''; const args = query.category ? [id, query.category, limit, page * limit] : [id, limit, page * limit];
    const rows = this.db.raw.prepare(`SELECT * FROM discrepancies WHERE scan_id=?${category} ORDER BY category, path LIMIT ? OFFSET ?`).all(...args);
    const counts = this.db.raw.prepare('SELECT category, COUNT(*) count FROM discrepancies WHERE scan_id=? GROUP BY category').all(id);
    return { rows, counts, page, limit };
  }
  browse(id, query) {
    const side = query.side === 'remote' ? 'remote' : query.side === 'local' ? 'local' : null;
    if (!side) throw new Error('Choose a valid browser side.');
    const rawPath = typeof query.path === 'string' ? query.path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '') : '';
    if (rawPath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid folder path.');
    const pathKey = rawPath.toLocaleLowerCase(); const prefix = pathKey ? `${pathKey}/` : '';
    const page = Math.max(0, Number(query.page || 0)); const limit = Math.min(500, Math.max(25, Number(query.limit || 200)));
    const directChildClause = prefix ? 'instr(substr(i.path_key, ?), \'/\') = 0' : "instr(i.path_key, '/') = 0";
    const args = prefix ? [id, side, `${prefix}%`, prefix.length + 1, limit + 1, page * limit] : [id, side, '%', limit + 1, page * limit];
    const rows = this.db.raw.prepare(`SELECT i.display_path, i.kind, i.size,
      (SELECT group_concat(category, ',') FROM discrepancies d WHERE d.scan_id=i.scan_id AND lower(d.path)=i.path_key) categories
      FROM inventory i WHERE i.scan_id=? AND i.side=? AND i.path_key LIKE ? AND ${directChildClause}
      ORDER BY CASE i.kind WHEN 'folder' THEN 0 ELSE 1 END, i.path_key LIMIT ? OFFSET ?`).all(...args);
    const hasMore = rows.length > limit; const entries = rows.slice(0, limit).map(row => ({
      name: prefix ? row.display_path.slice(prefix.length) : row.display_path,
      kind: row.kind, size: row.size, categories: row.categories ? row.categories.split(',') : []
    }));
    return { side, path: rawPath, entries, page, limit, hasMore };
  }
  async enqueue(names) {
    if (!this.db.getSetting('dropbox_access_token')) throw new Error('Connect Dropbox before scanning.');
    const all = await this.projects(); let chosen = Array.isArray(names) && names.length ? all.filter(p => names.includes(p.name)) : all;
    if (!Array.isArray(names) || !names.length) chosen = [...chosen, ...await this.additionalRemoteProjects(all)];
    if (!chosen.length) throw new Error('No local project folders found.');
    const insert = this.db.raw.prepare('INSERT INTO scans(project_name,local_path,remote_path,status,phase,remote_only) VALUES (?,?,?,?,?,?)');
    const ids = this.db.raw.transaction(items => items.map(p => insert.run(p.name, p.localPath, p.remotePath, 'queued', 'queued', p.remoteOnly ? 1 : 0).lastInsertRowid))(chosen);
    this.run(); return { scanIds: ids, queued: ids.length };
  }
  async retry(id) {
    const scan = this.db.raw.prepare('SELECT * FROM scans WHERE id=?').get(id); if (!scan) throw new Error('Scan not found.');
    this.db.raw.prepare("UPDATE scans SET status='queued', phase=CASE WHEN phase='remote' THEN 'remote' ELSE 'queued', error=NULL WHERE id=?").run(id); this.run(); return { ok: true };
  }
  resume() { this.db.raw.prepare("UPDATE scans SET status='queued', resumed=1 WHERE status='running'").run(); this.run(); }
  pause() { this.db.setSetting('queue_paused', 'true'); }
  resumeQueue() {
    this.db.setSetting('queue_paused', 'false');
    this.db.raw.prepare("UPDATE scans SET status='queued', resumed=1 WHERE status='paused'").run();
    this.run();
  }
  isPaused() { return this.db.getSetting('queue_paused') === 'true'; }
  assertNotPaused() { if (this.isPaused()) throw new ScanPaused(); }
  async run() {
    if (this.running) return; this.running = true;
    try { while (!this.isPaused()) { const scan = this.db.raw.prepare("SELECT * FROM scans WHERE status='queued' ORDER BY id LIMIT 1").get(); if (!scan) break; await this.execute(scan); } }
    finally { this.running = false; }
  }
  async execute(scan) {
    try {
      this.assertNotPaused();
      this.db.raw.prepare("UPDATE scans SET status='running', started_at=COALESCE(started_at,?), error=NULL WHERE id=?").run(new Date().toISOString(), scan.id);
      if ((scan.phase === 'queued' || scan.phase === 'local') && scan.local_path) await this.indexLocal(scan.id, scan.local_path);
      else if (!scan.local_path) this.db.raw.prepare("UPDATE scans SET local_done=1 WHERE id=?").run(scan.id);
      // A failed comparison can be retried without re-listing an already complete remote inventory.
      if (!scan.remote_done) await this.indexRemote(scan.id, scan.remote_path);
      this.assertNotPaused();
      this.compare(scan.id);
      this.db.raw.prepare("UPDATE scans SET status='complete', phase='complete', completed_at=? WHERE id=?").run(new Date().toISOString(), scan.id);
      this.prune();
    } catch (error) {
      if (error instanceof ScanPaused) this.db.raw.prepare("UPDATE scans SET status='paused' WHERE id=?").run(scan.id);
      else this.db.raw.prepare("UPDATE scans SET status='incomplete', error=? WHERE id=?").run(error.message, scan.id);
    }
  }
  async indexLocal(id, root) {
    this.db.raw.prepare("UPDATE scans SET phase='local', local_items=0, local_bytes=0, local_done=0 WHERE id=?").run(id);
    this.db.raw.prepare("DELETE FROM inventory WHERE scan_id=? AND side='local'").run(id);
    const insert = this.db.raw.prepare('INSERT OR REPLACE INTO inventory(scan_id,side,path_key,display_path,kind,size) VALUES (?,?,?,?,?,?)');
    let items = 0, bytes = 0; const batch = [];
    const flush = () => { if (!batch.length) return; this.db.raw.transaction(rows => rows.forEach(row => insert.run(...row)))(batch.splice(0)); this.db.raw.prepare('UPDATE scans SET local_items=?, local_bytes=? WHERE id=?').run(items, bytes, id); };
    for await (const item of walk(root)) {
      const rel = item.relative.replaceAll('\\', '/'); const key = rel.toLocaleLowerCase();
      batch.push([id, 'local', key, rel, item.kind, item.size]); items++; bytes += item.size;
      if (batch.length >= 1000) { flush(); this.assertNotPaused(); }
    }
    flush(); this.assertNotPaused(); this.db.raw.prepare("UPDATE scans SET local_done=1 WHERE id=?").run(id);
  }
  async indexRemote(id, remotePath) {
    let scan = this.db.raw.prepare('SELECT * FROM scans WHERE id=?').get(id);
    this.db.raw.prepare("UPDATE scans SET phase='remote' WHERE id=?").run(id);
    const insert = this.db.raw.prepare('INSERT OR REPLACE INTO inventory(scan_id,side,path_key,display_path,kind,size) VALUES (?,?,?,?,?,?)');
    let cursor = scan.remote_cursor; let remoteItems = scan.remote_items; let remoteBytes = scan.remote_bytes;
    if (!cursor) { this.db.raw.prepare("DELETE FROM inventory WHERE scan_id=? AND side='remote'").run(id); remoteItems = 0; remoteBytes = 0; }
    while (true) {
      this.assertNotPaused();
      let page;
      try { page = cursor ? await this.dropbox.api('/files/list_folder/continue', { cursor }) : await this.dropbox.api('/files/list_folder', { path: remotePath || '', recursive: true, include_deleted: false, include_mounted_folders: true }); }
      catch (error) {
        // A missing expected Dropbox project is a comparison finding, not an API failure.
        if (!cursor && /path\/not_found/i.test(error.message)) { this.db.raw.prepare("UPDATE scans SET remote_done=1 WHERE id=?").run(id); return; }
        throw error;
      }
      const rows = page.entries.filter(x => x['.tag'] === 'file' || x['.tag'] === 'folder').map(x => {
        const full = x.path_display || x.path_lower; const relative = full.slice((remotePath || '').length).replace(/^\//, '');
        return [id, 'remote', relative.toLocaleLowerCase(), relative, x['.tag'], x.size || 0];
      });
      this.db.raw.transaction(entries => entries.forEach(row => insert.run(...row)))(rows);
      remoteItems += rows.length; remoteBytes += rows.reduce((sum, row) => sum + row[5], 0); cursor = page.cursor;
      this.db.raw.prepare('UPDATE scans SET remote_cursor=?, remote_items=?, remote_bytes=? WHERE id=?').run(cursor, remoteItems, remoteBytes, id);
      if (!page.has_more) break;
    }
    this.db.raw.prepare("UPDATE scans SET remote_done=1, phase='compare' WHERE id=?").run(id);
  }
  compare(id) {
    const sql = this.db.raw;
    sql.prepare('DELETE FROM discrepancies WHERE scan_id=?').run(id);
    const write = sql.transaction(() => {
      // Set-based writes avoid keeping a SELECT iterator open while inserting on the same connection.
      sql.prepare(`INSERT INTO discrepancies(scan_id,category,path,local_kind,remote_kind,local_size,remote_size)
        SELECT l.scan_id, 'missing_in_dropbox', l.display_path, l.kind, NULL, l.size, NULL
        FROM inventory l LEFT JOIN inventory r ON r.scan_id=l.scan_id AND r.side='remote' AND r.path_key=l.path_key
        WHERE l.scan_id=? AND l.side='local' AND r.path_key IS NULL`).run(id);
      sql.prepare(`INSERT INTO discrepancies(scan_id,category,path,local_kind,remote_kind,local_size,remote_size)
        SELECT r.scan_id, 'additional_in_dropbox', r.display_path, NULL, r.kind, NULL, r.size
        FROM inventory r LEFT JOIN inventory l ON l.scan_id=r.scan_id AND l.side='local' AND l.path_key=r.path_key
        WHERE r.scan_id=? AND r.side='remote' AND l.path_key IS NULL`).run(id);
      sql.prepare(`INSERT INTO discrepancies(scan_id,category,path,local_kind,remote_kind,local_size,remote_size)
        SELECT l.scan_id, 'type_conflict', l.display_path, l.kind, r.kind, l.size, r.size
        FROM inventory l JOIN inventory r ON r.scan_id=l.scan_id AND r.side='remote' AND r.path_key=l.path_key
        WHERE l.scan_id=? AND l.side='local' AND l.kind<>r.kind`).run(id);
      sql.prepare(`INSERT INTO discrepancies(scan_id,category,path,local_kind,remote_kind,local_size,remote_size)
        SELECT l.scan_id, 'size_mismatch', l.display_path, l.kind, r.kind, l.size, r.size
        FROM inventory l JOIN inventory r ON r.scan_id=l.scan_id AND r.side='remote' AND r.path_key=l.path_key
        WHERE l.scan_id=? AND l.side='local' AND l.kind='file' AND l.size<>r.size`).run(id);
    }); write();
  }
  prune() { const limit = Number(this.db.getSetting('history_limit') || 5); const ids = this.db.raw.prepare("SELECT id FROM scans WHERE status='complete' ORDER BY completed_at DESC LIMIT -1 OFFSET ?").all(limit).map(x => x.id); if (!ids.length) return; const qs = ids.map(() => '?').join(','); this.db.raw.prepare(`DELETE FROM inventory WHERE scan_id IN (${qs})`).run(...ids); this.db.raw.prepare(`DELETE FROM discrepancies WHERE scan_id IN (${qs})`).run(...ids); this.db.raw.prepare(`DELETE FROM scans WHERE id IN (${qs})`).run(...ids); }
  async additionalRemoteProjects(local) {
    const localNames = new Set(local.map(p => p.name.toLocaleLowerCase())); const root = this.db.getSetting('dropbox_remote_root') || '';
    let cursor; const additions = [];
    do {
      const page = cursor ? await this.dropbox.api('/files/list_folder/continue', { cursor }) : await this.dropbox.api('/files/list_folder', { path: root, recursive: false, include_deleted: false, include_mounted_folders: true });
      for (const item of page.entries) if (item['.tag'] === 'folder' && !localNames.has(item.name.toLocaleLowerCase())) additions.push({ name: `Dropbox only: ${item.name}`, localPath: '', remotePath: item.path_display || item.path_lower, remoteOnly: true });
      cursor = page.has_more ? page.cursor : null;
    } while (cursor);
    return additions;
  }
}

async function* walk(root) {
  const queue = [{ disk: root, relative: '' }];
  while (queue.length) {
    const current = queue.shift(); let dir;
    try { dir = await fs.opendir(current.disk); } catch (error) { throw new Error(`Cannot read ${current.disk}: ${error.message}`); }
    for await (const entry of dir) {
      if (entry.isSymbolicLink()) continue;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name; const disk = path.join(current.disk, entry.name);
      if (entry.isDirectory()) { yield { relative, kind: 'folder', size: 0 }; queue.push({ disk, relative }); }
      else if (entry.isFile()) { const stat = await fs.stat(disk); yield { relative, kind: 'file', size: stat.size }; }
    }
  }
}
