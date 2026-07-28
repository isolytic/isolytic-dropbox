import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const categories = { missing_in_dropbox: 'Missing in Dropbox', additional_in_dropbox: 'Additional Dropbox items', type_conflict: 'Type conflicts', size_mismatch: 'Size mismatches' };
const APP_VERSION = __APP_VERSION__;

function App() {
  const [settings, setSettings] = useState(null); const [scans, setScans] = useState([]); const [projects, setProjects] = useState([]); const [search, setSearch] = useState(''); const [detail, setDetail] = useState(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const load = async () => { const [s, x, p] = await Promise.all([get('/api/settings'), get('/api/scans'), get('/api/projects').catch(() => [])]); setSettings(s); setScans(x); setProjects(p); };
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('dropbox') === 'error') {
      setMessage(params.get('message') || 'Dropbox connection was not completed.');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);
  useEffect(() => { load(); const timer = setInterval(load, 3000); return () => clearInterval(timer); }, []);
  const visible = useMemo(() => scans.filter(s => s.project_name.toLowerCase().includes(search.toLowerCase())), [scans, search]);
  const needsAttention = visible.filter(s => !s.remote_only && (classify(s) === 'attention' || s.status === 'incomplete')); const remoteOnly = visible.filter(s => s.remote_only); const good = visible.filter(s => !s.remote_only && classify(s) !== 'attention' && s.status !== 'incomplete');
  if (!settings) return <main className="loading">Loading Vault Compare…</main>;
  const save = async data => { setBusy(true); try { await send('/api/settings', 'PUT', data); setMessage('Saved.'); await load(); } catch (e) { setMessage(e.message); } finally { setBusy(false); } };
  const start = async names => { setBusy(true); try { const result = await send('/api/scans', 'POST', { projectNames: names }); setMessage(`${result.queued} project${result.queued === 1 ? '' : 's'} queued.`); await load(); } catch (e) { setMessage(e.message); } finally { setBusy(false); } };
  return <main>
    <header><div><span className="eyebrow">LOCAL → DROPBOX</span><h1>Vault Compare</h1></div><div className="header-actions"><input aria-label="Search projects" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search projects"/><button className="primary" disabled={busy || !settings.connected} onClick={() => start(null)}>Scan all</button></div></header>
    {message && <div className="toast">{message}<button onClick={() => setMessage('')}>×</button></div>}
    {!settings.connected ? <Setup settings={settings} save={save} busy={busy} setMessage={setMessage} load={load}/> : <>
      <section className="summary"><Metric label="Projects" value={projects.length}/><Metric label="Needs attention" value={needsAttention.length} tone={needsAttention.length ? 'bad' : ''}/><Metric label="Matched" value={good.filter(x => x.status === 'complete').length}/><Metric label="Queue" value={scans.filter(x => ['queued', 'running'].includes(x.status)).length}/></section>
      <section className="toolbar"><span>{settings.remoteRoot || '/'} on Dropbox</span><button disabled={busy} onClick={() => setDetail({ settings: true })}>Settings</button></section>
      <ProjectSection title="Needs attention" empty="No current mismatches." scans={needsAttention} onScan={name => start([name])} onDetail={setDetail}/>
      <ProjectSection title="Additional Dropbox projects" quiet empty="No additional Dropbox projects found." scans={remoteOnly} onScan={name => start([name])} onDetail={setDetail}/>
      <ProjectSection title="Matched & additions" quiet empty="No completed matching projects yet." scans={good} onScan={name => start([name])} onDetail={setDetail}/>
    </>}
    <footer>Vault Compare <span>v{APP_VERSION}</span></footer>
    {detail?.settings && <SettingsModal settings={settings} save={save} close={() => setDetail(null)} setMessage={setMessage} load={load}/>} {detail?.id && <DetailModal scan={detail} close={() => setDetail(null)}/>} 
  </main>;
}

function Setup({ settings, save, busy, setMessage, load }) {
  const [appKey, setAppKey] = useState(settings.appKey); const [remoteRoot, setRemoteRoot] = useState(settings.remoteRoot); const connect = async () => { try { await save({ appKey, remoteRoot, historyLimit: 5 }); const r = await get('/api/auth/dropbox/start'); window.location.assign(r.url); } catch (e) { setMessage(e.message); } };
  return <section className="setup"><span className="eyebrow">SETUP REQUIRED</span><h2>Connect your Dropbox</h2><p>This app only reads <code>{settings.vaultRoot}</code>, which Docker mounts from <code>T:\vault</code> as read-only.</p><label>Dropbox App Key<input value={appKey} onChange={e => setAppKey(e.target.value)} placeholder="Paste App Key"/></label><label>Dropbox mirror root<input value={remoteRoot} onChange={e => setRemoteRoot(e.target.value)} placeholder="/Vault mirror"/></label><p className="hint">Create an app in <a href="https://www.dropbox.com/developers/apps" target="_blank">Dropbox App Console</a>. Choose Full Dropbox access, add <code>{location.origin}/api/auth/dropbox/callback</code> as a redirect URI, then paste its App Key here.</p><button className="primary wide" disabled={busy || !appKey.trim()} onClick={connect}>Save & connect Dropbox</button></section>;
}
function SettingsModal({ settings, save, close, setMessage, load }) {
  const [appKey, setAppKey] = useState(settings.appKey); const [remoteRoot, setRemoteRoot] = useState(settings.remoteRoot); const [historyLimit, setHistoryLimit] = useState(settings.historyLimit); const [bundle, setBundle] = useState('');
  const exportBundle = async () => { const r = await get('/api/connection/export'); setBundle(r.bundle); navigator.clipboard?.writeText(r.bundle); setMessage('Connection bundle copied.'); };
  const importBundle = async () => { try { await send('/api/connection/import', 'POST', { bundle }); setMessage('Connection imported.'); await load(); close(); } catch (e) { setMessage(e.message); } };
  return <Modal title="Settings" close={close}><label>Dropbox App Key<input value={appKey} onChange={e => setAppKey(e.target.value)}/></label><label>Dropbox mirror root<input value={remoteRoot} onChange={e => setRemoteRoot(e.target.value)}/></label><label>History to retain<input type="number" min="1" max="100" value={historyLimit} onChange={e => setHistoryLimit(Number(e.target.value))}/></label><button className="primary" onClick={async () => { await save({ appKey, remoteRoot, historyLimit }); close(); }}>Save settings</button><hr/><h3>Transfer Dropbox connection</h3><p className="hint">For your local personal app only. This bundle contains access credentials—treat it like a password.</p><textarea value={bundle} onChange={e => setBundle(e.target.value)} placeholder="Export to copy, or paste a bundle to import"/><div className="row"><button onClick={exportBundle}>Export & copy</button><button onClick={importBundle} disabled={!bundle}>Import bundle</button></div></Modal>;
}
function ProjectSection({ title, scans, empty, quiet, onScan, onDetail }) { return <section className={`projects ${quiet ? 'quiet' : ''}`}><h2>{title}<span>{scans.length}</span></h2>{scans.length ? scans.map(scan => <ProjectRow key={scan.id} scan={scan} onScan={onScan} onDetail={onDetail}/>) : <p className="empty">{empty}</p>}</section>; }
function ProjectRow({ scan, onScan, onDetail }) { const state = classify(scan); const progress = scan.status === 'running' ? (scan.phase === 'local' ? scan.local_done ? 100 : 45 : scan.local_items ? Math.min(99, Math.round(scan.remote_items / scan.local_items * 100)) : 50) : 100; const extra = countCategory(scan, 'additional_in_dropbox'); return <article className={`project ${state} ${scan.status}`}><button className="project-main" onClick={() => scan.status === 'complete' && onDetail({ id: scan.id, name: scan.project_name })}><div><h3>{scan.project_name}</h3><p>{scan.status === 'running' ? `${scan.phase === 'local' ? 'Indexing vault' : 'Listing Dropbox'} · ${formatNumber(scan.phase === 'local' ? scan.local_items : scan.remote_items)} items` : label(scan, extra)}</p></div><div className="numbers"><strong>{scan.status === 'running' ? `${progress}%` : formatNumber(scan.discrepancy_count)}</strong><small>{scan.status === 'running' ? eta(scan) : 'findings'}</small></div></button>{scan.status === 'running' && <div className="progress"><i style={{ width: `${progress}%` }}/></div>}<div className="project-actions"><span className={`badge ${state}`}>{scan.remote_only ? 'Additional project' : scan.status === 'incomplete' ? 'Incomplete' : state === 'attention' ? 'Mismatch' : extra ? 'Matched + additions' : 'Matched'}</span>{!scan.remote_only && <button onClick={() => onScan(scan.project_name)}>Rescan</button>}</div></article>; }
function DetailModal({ scan, close }) { const [data, setData] = useState(null); const [category, setCategory] = useState(''); useEffect(() => { get(`/api/scans/${scan.id}/discrepancies${category ? `?category=${category}` : ''}`).then(setData); }, [scan.id, category]); return <Modal title={scan.name} close={close}>{!data ? <p>Loading findings…</p> : <><div className="tabs"><button className={!category ? 'active' : ''} onClick={() => setCategory('')}>All</button>{data.counts.map(x => <button key={x.category} className={category === x.category ? 'active' : ''} onClick={() => setCategory(x.category)}>{categories[x.category]} <b>{formatNumber(x.count)}</b></button>)}</div><div className="finding-list">{data.rows.map(x => <div className="finding" key={x.id}><span>{categories[x.category]}</span><code>{x.path}</code>{x.category === 'size_mismatch' && <small>{formatBytes(x.local_size)} local · {formatBytes(x.remote_size)} Dropbox</small>}</div>)}{!data.rows.length && <p className="empty">No findings.</p>}</div></>}</Modal>; }
function Modal({ title, close, children }) { return <div className="overlay" onMouseDown={close}><section className="modal" onMouseDown={e => e.stopPropagation()}><header><h2>{title}</h2><button className="icon" onClick={close}>×</button></header>{children}</section></div>; }
function Metric({ label, value, tone }) { return <div className={`metric ${tone || ''}`}><span>{label}</span><strong>{formatNumber(value)}</strong></div>; }
function classify(s) { if (s.status === 'incomplete') return 'attention'; const n = Number(s.discrepancy_count || 0) - countCategory(s, 'additional_in_dropbox'); return n > 0 ? 'attention' : 'good'; }
function countCategory(s, category) { return Number(s[category] || 0); }
function label(s, extra) { if (s.status === 'queued') return 'Waiting in scan queue'; if (s.status === 'incomplete') return s.error || 'Scan incomplete'; return s.discrepancy_count ? `${formatNumber(s.discrepancy_count)} differences found` : 'No differences found'; }
function eta(s) { if (!s.local_items || s.phase !== 'remote') return 'Estimating…'; const elapsed = Math.max(1, (Date.now() - new Date(s.started_at).getTime()) / 1000); const rate = Math.max(1, s.remote_items / elapsed); return `~${Math.ceil(Math.max(0, s.local_items - s.remote_items) / rate)}s left`; }
const formatNumber = n => new Intl.NumberFormat().format(Number(n || 0)); const formatBytes = n => n == null ? '—' : `${(n / 1024 / 1024).toFixed(1)} MB`;
async function get(url) { const r = await fetch(url); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Request failed'); return d; }
async function send(url, method, body) { const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Request failed'); return d; }
createRoot(document.getElementById('root')).render(<App/>);
