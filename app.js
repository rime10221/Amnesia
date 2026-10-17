'use strict';
/* =====================================================================
   Amnesia 낱말카드 - single-file app logic
   sections: utils / storage / data model / sync (Google Drive) /
             import-export / views / study / events / boot
   ===================================================================== */

/* ---------- utils ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const now = () => Date.now();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function shuffleSeeded(arr, seed) { const r = mulberry32(seed); const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function newSeed() { const c = new Uint32Array(1); crypto.getRandomValues(c); return c[0]; }
function stableStr(o) { if (o === null || typeof o !== 'object') return JSON.stringify(o); if (Array.isArray(o)) return '[' + o.map(stableStr).join(',') + ']'; return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + stableStr(o[k])).join(',') + '}'; }
function fmtTime(ts) { if (!ts) return '-'; const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`; }
let toastTimer;
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms); }
function loadScript(src) { return new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('스크립트 로드 실패: ' + src)); document.head.appendChild(s); }); }
function fontClass(t) { const n = (t || '').length; return n <= 18 ? 'fs-xl' : n <= 60 ? 'fs-l' : n <= 160 ? 'fs-m' : 'fs-s'; }
function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }

/* ---------- storage ---------- */
const LS = { data: 'amnesia.data.v1', set: 'amnesia.settings.v1', sess: 'amnesia.sessions.v1' };
function lsLoad(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function lsSave(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast('저장 실패: 저장 공간이 부족합니다'); return false; } }

let data = lsLoad(LS.data, null) || { decks: {}, progress: {} };
if (!data.progress) data.progress = {};
let settings = Object.assign({
  clientId: '', autoSync: true, theme: 'auto', flipAnim: true, swipe: true, showHint: true,
  signedIn: false, sync: { folderId: null, fileId: null, lastSync: null, email: null }
}, lsLoad(LS.set, {}));
let sessions = lsLoad(LS.sess, {});

function saveData() { lsSave(LS.data, data); scheduleSync(); }
function saveSettings() { lsSave(LS.set, settings); }
function saveSessions() { lsSave(LS.sess, sessions); }

/* ---------- data model ---------- */
const liveDecks = () => Object.values(data.decks).filter(d => !d.deleted).sort((a, b) => (a.order ?? a.created) - (b.order ?? b.created));
const liveCards = d => Object.values(d.cards).filter(c => !c.deleted).sort((a, b) => a.pos - b.pos || a.created - b.created);
const deckById = id => { const d = data.decks[id]; return d && !d.deleted ? d : null; };
function maxPos(d) { let m = 0; for (const c of Object.values(d.cards)) if (!c.deleted && c.pos > m) m = c.pos; return m; }
function createDeck(name) { const id = uid(); const t = now(); data.decks[id] = { id, name: name.trim() || '새 세트', created: t, updated: t, cards: {} }; saveData(); return id; }
function renameDeck(id, name) { const d = data.decks[id]; if (!d) return; d.name = name.trim() || d.name; d.updated = now(); saveData(); }
function deleteDeck(id) { const d = data.decks[id]; if (!d) return; d.deleted = true; d.updated = now(); delete sessions[id]; saveSessions(); saveData(); }
function addCards(deckId, pairs, skipDup = false) {
  const d = data.decks[deckId]; if (!d) return 0;
  const existing = new Set(skipDup ? liveCards(d).map(c => c.f.trim()) : []);
  let pos = maxPos(d) + 1, n = 0; const t = now();
  for (const [f, b] of pairs) {
    const ff = String(f ?? '').trim(), bb = String(b ?? '').trim();
    if (!ff && !bb) continue;
    if (skipDup && existing.has(ff)) continue;
    const id = uid(); d.cards[id] = { id, f: ff, b: bb, pos: pos++, created: t + n, updated: t + n }; existing.add(ff); n++;
  }
  if (n) { d.updated = now(); saveData(); }
  return n;
}
function updateCard(deckId, cardId, f, b) { const d = data.decks[deckId]; const c = d && d.cards[cardId]; if (!c) return; c.f = f.trim(); c.b = b.trim(); c.updated = now(); d.updated = c.updated; saveData(); }
function deleteCard(deckId, cardId) { const d = data.decks[deckId]; const c = d && d.cards[cardId]; if (!c) return; c.deleted = true; c.updated = now(); d.updated = c.updated; saveData(); }
function moveCard(deckId, cardId, dir) {
  const d = data.decks[deckId]; const list = liveCards(d); const i = list.findIndex(c => c.id === cardId); const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const a = list[i], b = list[j]; [a.pos, b.pos] = [b.pos, a.pos]; a.updated = b.updated = d.updated = now(); saveData();
}
function getP(deckId, cardId) { return (data.progress[deckId] || {})[cardId]; }
function setP(deckId, cardId, patch) { const p = data.progress[deckId] || (data.progress[deckId] = {}); p[cardId] = Object.assign(p[cardId] || { k: null, s: 0 }, patch, { u: now() }); saveData(); }
function deckStats(d) {
  const cards = liveCards(d); let ok = 0, no = 0, star = 0;
  for (const c of cards) { const p = getP(d.id, c.id); if (p) { if (p.k === 1) ok++; else if (p.k === 0) no++; if (p.s) star++; } }
  return { total: cards.length, ok, no, star, fresh: cards.length - ok - no };
}
function resetProgress(deckId) { delete data.progress[deckId]; data.progress[deckId] = {}; const d = data.decks[deckId]; for (const c of Object.values(d.cards)) data.progress[deckId][c.id] = { k: null, s: 0, u: now() }; delete sessions[deckId]; saveSessions(); saveData(); }

/* ---------- merge (sync) ---------- */
function mergeData(local, remote) {
  if (!remote) return JSON.parse(JSON.stringify(local));
  const out = { decks: {}, progress: {} };
  const ids = new Set([...Object.keys(local.decks || {}), ...Object.keys(remote.decks || {})]);
  for (const id of ids) {
    const a = local.decks[id], b = remote.decks[id];
    if (!a || !b) { out.decks[id] = JSON.parse(JSON.stringify(a || b)); continue; }
    const base = (a.updated >= b.updated) ? a : b;
    const m = { id, name: base.name, created: Math.min(a.created, b.created), updated: Math.max(a.updated, b.updated), cards: {} };
    if (base.deleted) m.deleted = true;
    if (base.order != null) m.order = base.order;
    const cids = new Set([...Object.keys(a.cards || {}), ...Object.keys(b.cards || {})]);
    for (const cid of cids) {
      const x = a.cards[cid], y = b.cards[cid];
      m.cards[cid] = JSON.parse(JSON.stringify(!x ? y : !y ? x : (x.updated >= y.updated ? x : y)));
    }
    out.decks[id] = m;
  }
  const pids = new Set([...Object.keys(local.progress || {}), ...Object.keys(remote.progress || {})]);
  for (const id of pids) {
    const a = local.progress[id] || {}, b = remote.progress[id] || {}; const m = {};
    for (const cid of new Set([...Object.keys(a), ...Object.keys(b)])) { const x = a[cid], y = b[cid]; m[cid] = Object.assign({}, !x ? y : !y ? x : ((x.u || 0) >= (y.u || 0) ? x : y)); }
    out.progress[id] = m;
  }
  return out;
}

/* ---------- Google Drive sync ---------- */
const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
const DRIVE = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'Amnesia', FILE = 'amnesia-decks.json';
const sync = { token: null, exp: 0, client: null, status: 'off', msg: '', busy: false, timer: null, pending: false };

function syncStatus() {
  if (!settings.clientId) return { cls: '', text: '동기화 꺼짐' };
  if (sync.status === 'busy') return { cls: 'busy', text: '동기화 중…' };
  if (sync.status === 'error') return { cls: 'err', text: '동기화 오류' };
  if (!settings.signedIn) return { cls: '', text: '로그인 필요' };
  return { cls: 'ok', text: settings.sync.lastSync ? '동기화 ' + fmtTime(settings.sync.lastSync) : '로그인됨' };
}
function setStatus(s, msg = '') { sync.status = s; sync.msg = msg; document.querySelectorAll('[data-sync-pill]').forEach(el => { const st = syncStatus(); el.className = 'pill ' + st.cls; el.innerHTML = `<i class="dot"></i>${esc(st.text)}`; }); const d = $('#sync-detail'); if (d) d.textContent = msg || (settings.sync.email ? settings.sync.email : ''); }

async function ensureGis() {
  if (!settings.clientId) throw new Error('설정에서 Google 클라이언트 ID를 먼저 입력하세요');
  await loadScript('https://accounts.google.com/gsi/client');
  if (!sync.client) sync.client = google.accounts.oauth2.initTokenClient({ client_id: settings.clientId, scope: SCOPES, callback: () => { } });
}
function getToken(interactive) {
  return new Promise(async (res, rej) => {
    try { await ensureGis(); } catch (e) { return rej(e); }
    if (sync.token && now() < sync.exp) return res(sync.token);
    sync.client.callback = r => { if (r.error) return rej(new Error(r.error_description || r.error)); sync.token = r.access_token; sync.exp = now() + (r.expires_in - 90) * 1000; res(sync.token); };
    sync.client.error_callback = e => rej(new Error(e.type === 'popup_closed' ? '로그인 창이 닫혔습니다' : e.type === 'popup_failed_to_open' ? '팝업이 차단되어 로그인할 수 없습니다' : (e.message || e.type)));
    sync.client.requestAccessToken(interactive ? { prompt: 'select_account' } : { prompt: '' });
  });
}
async function gfetch(url, opt = {}, interactive = false) {
  const tok = await getToken(interactive);
  const r = await fetch(url, Object.assign({}, opt, { headers: Object.assign({ Authorization: 'Bearer ' + tok }, opt.headers || {}) }));
  if (r.status === 401) { sync.token = null; throw new Error('인증이 만료되었습니다. 다시 로그인하세요'); }
  if (!r.ok) { let t = ''; try { t = (await r.json()).error.message; } catch (e) { t = r.statusText; } throw new Error('Drive 오류: ' + t); }
  return r;
}
async function signIn() {
  setStatus('busy', '로그인 중…');
  try {
    await getToken(true);
    const me = await (await gfetch('https://www.googleapis.com/oauth2/v3/userinfo')).json();
    settings.signedIn = true; settings.sync.email = me.email || null; saveSettings();
    setStatus('idle'); toast('로그인됨: ' + (me.email || ''));
    await runSync(true);
  } catch (e) { setStatus('error', e.message); toast(e.message, 4000); }
  render();
}
function signOut() {
  if (sync.token && window.google) try { google.accounts.oauth2.revoke(sync.token, () => { }); } catch (e) { }
  sync.token = null; sync.exp = 0; settings.signedIn = false; settings.sync = { folderId: null, fileId: null, lastSync: null, email: null }; saveSettings(); setStatus('idle'); render();
}
async function driveFolder() {
  if (settings.sync.folderId) { try { const r = await gfetch(`${DRIVE}/files/${settings.sync.folderId}?fields=id,trashed`); const j = await r.json(); if (!j.trashed) return j.id; } catch (e) { } settings.sync.folderId = null; }
  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = (await (await gfetch(`${DRIVE}/files?q=${q}&fields=files(id)&spaces=drive`)).json()).files;
  let id = found && found[0] && found[0].id;
  if (!id) { const r = await gfetch(`${DRIVE}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) }); id = (await r.json()).id; }
  settings.sync.folderId = id; saveSettings(); return id;
}
async function driveFile(folderId) {
  if (settings.sync.fileId) { try { const r = await gfetch(`${DRIVE}/files/${settings.sync.fileId}?fields=id,modifiedTime,trashed`); const j = await r.json(); if (!j.trashed) return j; } catch (e) { } settings.sync.fileId = null; }
  const q = encodeURIComponent(`name='${FILE}' and '${folderId}' in parents and trashed=false`);
  const found = (await (await gfetch(`${DRIVE}/files?q=${q}&fields=files(id,modifiedTime)`)).json()).files;
  return found && found[0] || null;
}
async function driveUpload(folderId, fileId, text) {
  if (fileId) {
    const r = await gfetch(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text });
    return r.json();
  }
  const boundary = 'amnesia' + now();
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE, parents: [folderId], mimeType: 'application/json' })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
  const r = await gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
  return r.json();
}
async function runSync(interactive = false) {
  if (!settings.clientId || !settings.signedIn) return;
  if (sync.busy) { sync.pending = true; return; }
  sync.busy = true; setStatus('busy');
  try {
    const folderId = await driveFolder();
    const file = await driveFile(folderId);
    let remote = null;
    if (file) { const r = await gfetch(`${DRIVE}/files/${file.id}?alt=media`); try { remote = await r.json(); } catch (e) { remote = null; } if (remote && !remote.decks) remote = null; }
    const merged = mergeData(data, remote);
    const localChanged = stableStr(merged) !== stableStr(data);
    const remoteChanged = !remote || stableStr(merged) !== stableStr(remote);
    if (localChanged) { data = merged; lsSave(LS.data, data); }
    if (remoteChanged) { const j = await driveUpload(folderId, file && file.id, JSON.stringify(merged)); settings.sync.fileId = j.id; }
    else settings.sync.fileId = file.id;
    settings.sync.lastSync = now(); saveSettings(); setStatus('idle');
    if (localChanged) { render(); toast('드라이브에서 변경사항을 가져왔습니다'); }
    else if (interactive) toast('동기화 완료');
  } catch (e) {
    console.warn(e);
    if (/만료|로그인|팝업/.test(e.message)) { settings.signedIn = interactive ? settings.signedIn : settings.signedIn; }
    setStatus('error', e.message); if (interactive) toast(e.message, 4000);
  } finally {
    sync.busy = false;
    if (sync.pending) { sync.pending = false; scheduleSync(); }
  }
}
function scheduleSync() { if (!settings.clientId || !settings.signedIn || !settings.autoSync) return; clearTimeout(sync.timer); sync.timer = setTimeout(() => runSync(false), 2500); }

/* ---------- import / export ---------- */
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
async function ensureXlsx() { if (!window.XLSX) await loadScript(XLSX_URL); }
function detectHeader(row) { const words = ['단어', '뜻', '앞', '뒤', '앞면', '뒷면', '질문', '답', '정답', '용어', 'front', 'back', 'term', 'definition', 'word', 'meaning', 'question', 'answer', '질환', '항생제', '제목', 'title', '세트', 'deck', '과목', '분류', '카테고리'].map(s => s.toLowerCase()); return row.some(c => words.includes(String(c ?? '').trim().toLowerCase())); }
function splitLine(line, delim) {
  if (delim === 'tab') { const i = line.indexOf('\t'); return i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)]; }
  if (delim === 'colon') { const m = line.match(/\s+:\s+|\s*：\s*|\s*:\s*/); if (!m) return [line, '']; const i = line.indexOf(m[0]); return [line.slice(0, i), line.slice(i + m[0].length)]; }
  if (delim === 'dash') { const m = line.match(/\s+-\s+|\s*–\s*|\s*—\s*/); if (!m) return [line, '']; const i = line.indexOf(m[0]); return [line.slice(0, i), line.slice(i + m[0].length)]; }
  if (delim === 'comma') { const i = line.indexOf(','); return i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)]; }
  // auto
  if (line.includes('\t')) return splitLine(line, 'tab');
  if (/\s+:\s+/.test(line)) return splitLine(line, 'colon');
  if (/\s+-\s+/.test(line)) return splitLine(line, 'dash');
  if (/:/.test(line)) return splitLine(line, 'colon');
  if (/,/.test(line)) return splitLine(line, 'comma');
  return [line, ''];
}
async function parseFile(file) {
  const name = file.name.toLowerCase();
  if (/\.(xlsx|xlsm|xls|csv)$/.test(name)) {
    await ensureXlsx();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', codepage: 65001 });
    const sheets = wb.SheetNames.map(n => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: false }).filter(r => r.some(c => String(c).trim() !== '')) }));
    return { sheets };
  }
  const text = await file.text();
  const rows = text.split(/\r?\n/).filter(l => l.trim()).map(l => splitLine(l, 'auto'));
  return { sheets: [{ name: 'text', rows }] };
}
async function exportDeckXlsx(d) {
  await ensureXlsx();
  const rows = [['앞면', '뒷면']].concat(liveCards(d).map(c => [c.f, c.b]));
  const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = [{ wch: 40 }, { wch: 70 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'cards');
  XLSX.writeFile(wb, `${d.name}.xlsx`);
}

/* ---------- router / render ---------- */
const app = $('#app');
function route() { const p = (location.hash.slice(1) || '/').split('/').filter(Boolean); return { name: p[0] || 'home', id: p[1] ? decodeURIComponent(p[1]) : null }; }
function go(h) { location.hash = h; }
function render() {
  const r = route();
  const views = { home: viewHome, deck: viewDeck, study: viewStudy, settings: viewSettings };
  const fn = views[r.name] || viewHome;
  app.innerHTML = fn(r.id);
  afterRender(r);
}
window.addEventListener('hashchange', render);
function pill() { const st = syncStatus(); return `<button class="pill ${st.cls}" data-sync-pill data-action="sync-pill"><i class="dot"></i>${esc(st.text)}</button>`; }
function topbar(title, left, right = '') { return `<div class="topbar">${left || ''}<h1>${esc(title)}</h1>${right}</div>`; }

/* ---------- view: home ---------- */
function viewHome() {
  const decks = liveDecks();
  const list = decks.length ? decks.map(d => {
    const s = deckStats(d); const pct = s.total ? Math.round(s.ok / s.total * 100) : 0;
    return `<button class="deck" data-action="open-deck" data-id="${d.id}">
      <div class="grow">
        <div class="name">${esc(d.name)}</div>
        <div class="meta">${s.total}장 · 알았음 ${s.ok} · 모름 ${s.no} · 미학습 ${s.fresh}${s.star ? ' · ★' + s.star : ''}</div>
        <div class="bar multi"><i style="width:${pct}%"></i><i class="no" style="width:${s.total ? Math.round(s.no / s.total * 100) : 0}%"></i></div>
      </div><span class="muted">›</span></button>`;
  }).join('') : `<div class="empty"><div class="big">🗂️</div>아직 세트가 없습니다.<br>오른쪽 아래 + 버튼으로 세트를 만들거나<br>엑셀 파일을 가져오세요.</div>`;
  return topbar('Amnesia', '', `${pill()}<button class="iconbtn" data-action="go" data-to="#/settings" title="설정">⚙️</button>`) +
    `<div class="page">
      <div class="row" style="margin-bottom:12px">
        <button class="btn grow" data-action="import" data-deck="">📥 엑셀/텍스트 가져오기</button>
      </div>
      ${list}
    </div>
    <button class="fab" data-action="new-deck" title="새 세트">+</button>`;
}

/* ---------- view: deck ---------- */
let deckSearch = '', listLimit = 200;
function sessOpts(deckId, total) {
  const s = sessions[deckId] || {}; const o = Object.assign({ mode: 'seq', from: 1, to: total, filter: 'all', reverse: false }, s.opts || {});
  o.from = clamp(o.from, 1, Math.max(1, total)); o.to = clamp(o.to, o.from, Math.max(1, total)); if (!s.opts || s.opts.to == null || s.opts.toAll) o.to = total;
  return o;
}
function countForOpts(d, o) {
  const cards = liveCards(d).slice(o.from - 1, o.to);
  if (o.filter === 'unknown') return cards.filter(c => !(getP(d.id, c.id) || {}).k).length;
  if (o.filter === 'wrong') return cards.filter(c => (getP(d.id, c.id) || {}).k === 0).length;
  if (o.filter === 'star') return cards.filter(c => (getP(d.id, c.id) || {}).s).length;
  return cards.length;
}
function viewDeck(id) {
  const d = deckById(id); if (!d) return viewHome();
  const cards = liveCards(d); const s = deckStats(d); const o = sessOpts(id, cards.length);
  const sess = sessions[id] && sessions[id].cur; const canResume = sess && sess.i < sess.ids.length && sess.ids.length > 0;
  const n = countForOpts(d, o);
  const chunk = cards.length > 60 ? (sessions[id] && sessions[id].chunk) || 50 : 0;
  let chunks = '';
  if (chunk) { const parts = []; for (let a = 1; a <= cards.length; a += chunk) { const b = Math.min(a + chunk - 1, cards.length); parts.push(`<button class="chip ${o.from === a && o.to === b ? 'on' : ''}" data-action="range" data-from="${a}" data-to="${b}">${a}–${b}</button>`); } chunks = `<div class="row" style="margin-top:8px"><span class="muted">묶음</span><select class="input" style="width:auto;min-height:34px;padding:4px 8px" data-change="chunk"><option ${chunk == 20 ? 'selected' : ''}>20</option><option ${chunk == 30 ? 'selected' : ''}>30</option><option ${chunk == 50 ? 'selected' : ''}>50</option><option ${chunk == 100 ? 'selected' : ''}>100</option></select><span class="muted">개씩</span></div><div class="chips" style="margin-top:8px">${parts.join('')}</div>`; }
  const q = deckSearch.trim().toLowerCase();
  const shown = q ? cards.filter(c => c.f.toLowerCase().includes(q) || c.b.toLowerCase().includes(q)) : cards;
  const rows = shown.slice(0, listLimit).map(c => { const p = getP(id, c.id) || {}; const idx = cards.indexOf(c) + 1; return `<div class="cardrow" data-card="${c.id}">
      <div class="idx">${idx}</div>
      <div class="txt" data-action="edit-card" data-id="${c.id}"><div class="f">${esc(c.f)}${p.k === 1 ? '<span class="tag ok">알았음</span>' : p.k === 0 ? '<span class="tag no">모름</span>' : ''}</div><div class="b">${esc(c.b)}</div></div>
      <div class="acts"><button class="star ${p.s ? 'on' : ''}" data-action="star" data-id="${c.id}" title="별표">${p.s ? '★' : '☆'}</button><button data-action="card-menu" data-id="${c.id}" title="더보기">⋯</button></div>
    </div>`; }).join('');
  return topbar(d.name, `<button class="iconbtn" data-action="go" data-to="#/">‹</button>`, `${pill()}<button class="iconbtn" data-action="deck-menu" title="세트 메뉴">⋮</button>`) +
    `<div class="page">
      <div class="card-box">
        <h2>학습 설정 <span class="muted" style="font-weight:400">· 총 ${cards.length}장 · 알았음 ${s.ok} · 모름 ${s.no}</span></h2>
        <div class="chips" style="margin-bottom:10px">
          <button class="chip ${o.mode === 'seq' ? 'on' : ''}" data-action="opt" data-k="mode" data-v="seq">순서대로</button>
          <button class="chip ${o.mode === 'shuffle' ? 'on' : ''}" data-action="opt" data-k="mode" data-v="shuffle">🔀 섞어서</button>
          <button class="chip ${o.reverse ? 'on' : ''}" data-action="opt" data-k="reverse" data-v="${o.reverse ? 0 : 1}">↔ 뒷면부터</button>
        </div>
        <div class="chips" style="margin-bottom:10px">
          <button class="chip ${o.filter === 'all' ? 'on' : ''}" data-action="opt" data-k="filter" data-v="all">전체</button>
          <button class="chip ${o.filter === 'unknown' ? 'on' : ''}" data-action="opt" data-k="filter" data-v="unknown">아직 못 외운 것 (${countForOpts(d, Object.assign({}, o, { filter: 'unknown' }))})</button>
          <button class="chip ${o.filter === 'wrong' ? 'on' : ''}" data-action="opt" data-k="filter" data-v="wrong">모름 표시만 (${countForOpts(d, Object.assign({}, o, { filter: 'wrong' }))})</button>
          <button class="chip ${o.filter === 'star' ? 'on' : ''}" data-action="opt" data-k="filter" data-v="star">★ 별표만 (${countForOpts(d, Object.assign({}, o, { filter: 'star' }))})</button>
        </div>
        <div class="row"><span class="muted">범위</span>
          <input class="input num" type="number" inputmode="numeric" min="1" max="${cards.length}" value="${o.from}" data-change="from"> <span class="muted">~</span>
          <input class="input num" type="number" inputmode="numeric" min="1" max="${cards.length}" value="${o.to}" data-change="to"> <span class="muted">번</span>
          <button class="btn sm" data-action="range" data-from="1" data-to="${cards.length}">전체</button>
        </div>
        ${chunks}
        <div class="row" style="margin-top:14px">
          ${canResume ? `<button class="btn primary grow" data-action="resume">▶ 이어하기 (${sess.i + 1}/${sess.ids.length})</button><button class="btn" data-action="start" ${n ? '' : 'disabled'}>처음부터</button>` : `<button class="btn primary grow" data-action="start" ${n ? '' : 'disabled'}>▶ 학습 시작 (${n}장)</button>`}
        </div>
      </div>
      <div class="card-box">
        <h2>카드 추가</h2>
        <form data-form="add-card">
          <input class="input" name="f" placeholder="앞면 (단어)" autocomplete="off" style="margin-bottom:8px">
          <textarea class="input" name="b" placeholder="뒷면 (뜻)" rows="2" style="min-height:60px;margin-bottom:8px"></textarea>
          <div class="row"><button class="btn primary" type="submit">추가</button><button class="btn" type="button" data-action="import" data-deck="${d.id}">📥 파일/텍스트로 대량 추가</button></div>
        </form>
      </div>
      <div class="card-box">
        <div class="row" style="margin-bottom:8px"><h2 style="margin:0" class="grow">카드 목록 (${cards.length})</h2><input class="input" style="width:50%;min-height:38px" placeholder="검색" value="${esc(deckSearch)}" data-input="search"></div>
        ${rows || '<div class="muted">카드가 없습니다.</div>'}
        ${shown.length > listLimit ? `<div class="row" style="padding-top:10px;justify-content:center"><button class="btn sm" data-action="more">더 보기 (${shown.length - listLimit}장 남음)</button><button class="btn sm ghost" data-action="more-all">전부 펼치기</button></div>` : ''}
      </div>
    </div>`;
}

/* ---------- study session ---------- */
function buildSession(deckId, o, ids) {
  const d = data.decks[deckId];
  let list;
  if (ids) list = ids.map(i => d.cards[i]).filter(c => c && !c.deleted);
  else {
    list = liveCards(d).slice(o.from - 1, o.to);
    if (o.filter === 'unknown') list = list.filter(c => !(getP(deckId, c.id) || {}).k);
    else if (o.filter === 'wrong') list = list.filter(c => (getP(deckId, c.id) || {}).k === 0);
    else if (o.filter === 'star') list = list.filter(c => (getP(deckId, c.id) || {}).s);
  }
  let cid = list.map(c => c.id); const seed = newSeed();
  if (o.mode === 'shuffle') cid = shuffleSeeded(cid, seed);
  return { ids: cid, i: 0, back: false, seed, mode: o.mode, reverse: !!o.reverse, res: {}, started: now() };
}
function startStudy(deckId, ids) {
  const d = deckById(deckId); if (!d) return;
  const o = sessOpts(deckId, liveCards(d).length);
  const s = sessions[deckId] || (sessions[deckId] = {}); s.opts = o; s.cur = buildSession(deckId, o, ids); saveSessions();
  go('#/study/' + deckId);
}
function viewStudy(id) {
  const d = deckById(id); const s = sessions[id] && sessions[id].cur;
  if (!d || !s) return viewDeck(id);
  const total = s.ids.length;
  if (s.i >= total || total === 0) {
    const ok = Object.values(s.res).filter(v => v === 1).length, no = Object.values(s.res).filter(v => v === 0).length;
    const wrongIds = s.ids.filter(i => s.res[i] === 0);
    return `<div class="study">${topbar(d.name, `<button class="iconbtn" data-action="go" data-to="#/deck/${id}">‹</button>`)}
      <div class="stage"><div class="summary">
        <div style="font-size:40px">🎉</div><h3 style="margin:8px 0">학습 완료</h3>
        <div class="nums"><div class="ok"><b>${ok}</b>알았음</div><div class="no"><b>${no}</b>모름</div><div><b>${total - ok - no}</b>건너뜀</div></div>
        <div class="row" style="justify-content:center">
          ${wrongIds.length ? `<button class="btn no" data-action="restudy-wrong">모른 것만 다시 (${wrongIds.length})</button>` : ''}
          <button class="btn primary" data-action="start">처음부터 다시</button>
          <button class="btn" data-action="go" data-to="#/deck/${id}">세트로 돌아가기</button>
        </div></div></div></div>`;
  }
  const c = d.cards[s.ids[s.i]]; const p = getP(id, c.id) || {};
  const front = s.reverse ? c.b : c.f, back = s.reverse ? c.f : c.b;
  const done = Object.keys(s.res).length;
  return `<div class="study">
    ${topbar(d.name, `<button class="iconbtn" data-action="go" data-to="#/deck/${id}" title="나가기">✕</button>`, `<button class="iconbtn" data-action="study-menu" title="옵션">⋮</button>`)}
    <div class="stage">
      <div class="progress"><span>${s.i + 1} / ${total}</span><div class="bar"><i style="width:${Math.round(s.i / total * 100)}%"></i></div><span>${s.mode === 'shuffle' ? '🔀 ' : ''}${done}장 평가</span></div>
      <div class="flip ${s.back ? 'back' : ''} ${settings.flipAnim ? '' : 'noanim'}" id="flip">
        <div class="inner">
          <div class="face" data-action="flip"><span class="label">${s.reverse ? '뒷면' : '앞면'}</span><button class="star ${p.s ? 'on' : ''}" data-action="star" data-id="${c.id}">${p.s ? '★' : '☆'}</button><div class="content ${fontClass(front)}">${esc(front)}</div>${settings.showHint ? '<span class="hint">탭하면 뒤집힘</span>' : ''}</div>
          <div class="face backface" data-action="flip"><span class="label">${s.reverse ? '앞면' : '뒷면'}</span><button class="star ${p.s ? 'on' : ''}" data-action="star" data-id="${c.id}">${p.s ? '★' : '☆'}</button><div class="content ${fontClass(back)}">${esc(back)}</div></div>
        </div>
      </div>
    </div>
    <div class="actions">
      <div class="row">
        <button class="btn nav" data-action="prev" ${s.i === 0 ? 'disabled' : ''}>‹</button>
        <button class="btn no" data-action="mark" data-v="0">모름</button>
        <button class="btn ok" data-action="mark" data-v="1">알았음</button>
        <button class="btn nav" data-action="next">›</button>
      </div>
    </div>
  </div>`;
}

/* ---------- view: settings ---------- */
let showHelp = false;
function viewSettings() {
  const st = syncStatus();
  return topbar('설정', `<button class="iconbtn" data-action="go" data-to="#/">‹</button>`) +
    `<div class="page">
      <div class="card-box">
        <h2>구글 드라이브 동기화</h2>
        <div class="row" style="margin-bottom:10px"><span class="pill ${st.cls}" data-sync-pill><i class="dot"></i>${esc(st.text)}</span><span class="muted" id="sync-detail">${esc(sync.msg || settings.sync.email || '')}</span></div>
        <label class="field"><span>Google OAuth 클라이언트 ID</span><input class="input" data-input="clientId" value="${esc(settings.clientId)}" placeholder="xxxx.apps.googleusercontent.com" autocomplete="off"></label>
        <div class="row" style="margin-bottom:10px">
          ${settings.signedIn ? `<button class="btn" data-action="sync-now">지금 동기화</button><button class="btn ghost" data-action="sign-out">로그아웃</button>` : `<button class="btn primary" data-action="sign-in" ${settings.clientId ? '' : 'disabled'}>Google 로그인</button>`}
          <button class="btn ghost sm" data-action="toggle-help">${showHelp ? '도움말 닫기' : '설정 방법 보기'}</button>
        </div>
        ${showHelp ? `<div class="help">
          <b>최초 1회, 내 구글 계정으로 앱을 등록합니다 (무료)</b>
          <ol>
            <li><a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a>에서 새 프로젝트 생성</li>
            <li><b>API 및 서비스 → 라이브러리</b>에서 <code>Google Drive API</code> 사용 설정</li>
            <li><b>OAuth 동의 화면</b>: 외부(External) 선택, 앱 이름 입력, <b>테스트 사용자</b>에 내 Gmail 추가</li>
            <li><b>사용자 인증 정보 → OAuth 클라이언트 ID 만들기</b>: 유형 "웹 애플리케이션", <b>승인된 JavaScript 원본</b>에 이 앱의 주소(예: <code>${esc(location.origin)}</code>) 추가</li>
            <li>생성된 클라이언트 ID를 위 칸에 붙여넣고 로그인</li>
          </ol>
          데이터는 내 드라이브의 <code>Amnesia/amnesia-decks.json</code>에 저장되며, 같은 클라이언트 ID로 로그인한 모든 기기에서 자동으로 합쳐집니다.
        </div>` : ''}
        <label class="switch"><span>자동 동기화 (변경 후 몇 초 뒤, 앱 열 때)</span><input type="checkbox" data-change="autoSync" ${settings.autoSync ? 'checked' : ''}></label>
      </div>
      <div class="card-box">
        <h2>학습 화면</h2>
        <label class="switch"><span>뒤집기 애니메이션</span><input type="checkbox" data-change="flipAnim" ${settings.flipAnim ? 'checked' : ''}></label>
        <label class="switch"><span>좌우로 밀어서 이전/다음</span><input type="checkbox" data-change="swipe" ${settings.swipe ? 'checked' : ''}></label>
        <label class="switch"><span>"탭하면 뒤집힘" 안내 표시</span><input type="checkbox" data-change="showHint" ${settings.showHint ? 'checked' : ''}></label>
        <label class="field" style="margin-top:8px"><span>테마</span><select class="input" data-change="theme"><option value="auto" ${settings.theme === 'auto' ? 'selected' : ''}>시스템 설정</option><option value="light" ${settings.theme === 'light' ? 'selected' : ''}>라이트</option><option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>다크</option></select></label>
      </div>
      <div class="card-box">
        <h2>데이터</h2>
        <div class="row">
          <button class="btn" data-action="backup">전체 백업 (JSON)</button>
          <button class="btn" data-action="restore">백업 복원</button>
          <button class="btn no ghost" data-action="wipe" style="color:var(--no)">전체 삭제</button>
        </div>
        <div class="muted" style="margin-top:8px">세트 ${liveDecks().length}개 · 카드 ${liveDecks().reduce((a, d) => a + liveCards(d).length, 0)}장 · 저장 용량 ${(JSON.stringify(data).length / 1024).toFixed(0)} KB</div>
        <div id="install-row" class="row hidden" style="margin-top:10px"><button class="btn primary" data-action="install">📱 홈 화면에 앱 설치</button></div>
      </div>
      <div class="muted" style="text-align:center">Amnesia 낱말카드 · 키보드: Space 뒤집기, ←/→ 이동, 1 모름, 2 알았음</div>
    </div>`;
}

/* ---------- modals ---------- */
function openModal(html) { $('#modal-root').innerHTML = `<div class="modal-bg" data-action="close-modal-bg"><div class="modal">${html}</div></div>`; }
function closeModal() { $('#modal-root').innerHTML = ''; }
function confirmModal(title, body, okText, onOk, danger = false) {
  openModal(`<h3>${esc(title)}</h3><div class="small" style="color:var(--muted)">${body}</div><div class="foot"><button class="btn" data-action="close-modal">취소</button><button class="btn ${danger ? 'no' : 'primary'}" id="modal-ok">${esc(okText)}</button></div>`);
  $('#modal-ok').onclick = () => { closeModal(); onOk(); };
}
function promptModal(title, value, okText, onOk, placeholder = '') {
  openModal(`<h3>${esc(title)}</h3><input class="input" id="modal-input" value="${esc(value)}" placeholder="${esc(placeholder)}"><div class="foot"><button class="btn" data-action="close-modal">취소</button><button class="btn primary" id="modal-ok">${esc(okText)}</button></div>`);
  const inp = $('#modal-input'); inp.focus(); inp.select();
  const ok = () => { closeModal(); onOk(inp.value); };
  $('#modal-ok').onclick = ok; inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
}
function editCardModal(deckId, cardId) {
  const c = data.decks[deckId].cards[cardId];
  openModal(`<h3>카드 편집</h3>
    <label class="field"><span>앞면</span><textarea class="input" id="ec-f" rows="2">${esc(c.f)}</textarea></label>
    <label class="field"><span>뒷면</span><textarea class="input" id="ec-b" rows="4">${esc(c.b)}</textarea></label>
    <div class="row small" style="margin-bottom:6px"><button class="btn sm" id="ec-up">↑ 위로</button><button class="btn sm" id="ec-down">↓ 아래로</button><button class="btn sm" id="ec-reset">학습 기록 지우기</button><span class="grow"></span><button class="btn sm" id="ec-del" style="color:var(--no)">삭제</button></div>
    <div class="foot"><button class="btn" data-action="close-modal">취소</button><button class="btn primary" id="modal-ok">저장</button></div>`);
  $('#modal-ok').onclick = () => { updateCard(deckId, cardId, $('#ec-f').value, $('#ec-b').value); closeModal(); render(); };
  $('#ec-up').onclick = () => { moveCard(deckId, cardId, -1); render(); closeModal(); };
  $('#ec-down').onclick = () => { moveCard(deckId, cardId, 1); render(); closeModal(); };
  $('#ec-reset').onclick = () => { setP(deckId, cardId, { k: null }); closeModal(); render(); };
  $('#ec-del').onclick = () => { deleteCard(deckId, cardId); closeModal(); render(); toast('삭제했습니다'); };
}

/* import wizard */
let imp = null;
function importModal(deckId) {
  imp = { deckId, step: 1, sheets: null, si: 0, header: null, colF: 0, colB: 1, colD: -1, target: deckId ? 'deck' : 'new', newName: '', skipDup: true, delim: 'auto', text: '' };
  renderImport();
}
function renderImport() {
  if (imp.step === 1) {
    openModal(`<h3>카드 가져오기</h3>
      <div class="help" style="margin-bottom:10px">엑셀(.xlsx) / CSV / 텍스트 파일을 선택하세요. 안드로이드에서는 파일 선택 창에서 <b>Google 드라이브</b>의 파일도 바로 고를 수 있습니다.</div>
      <input type="file" id="imp-file" accept=".xlsx,.xls,.xlsm,.csv,.txt,.tsv" class="input" style="padding:8px">
      <div class="muted" style="margin:14px 0 6px">또는 직접 붙여넣기 (한 줄에 한 카드: <code>단어[Tab]뜻</code>, <code>단어 : 뜻</code>, <code>단어 - 뜻</code>)</div>
      <textarea class="input" id="imp-text" rows="6" placeholder="자궁내막염(endometritis) : clindamycin + gentamicin&#10;유방염(mastitis) : dicloxacillin">${esc(imp.text)}</textarea>
      <div class="row" style="margin-top:8px"><span class="muted">구분자</span><select class="input" id="imp-delim" style="width:auto;min-height:36px;padding:4px 8px"><option value="auto">자동</option><option value="tab">탭</option><option value="colon">콜론 :</option><option value="dash">하이픈 -</option><option value="comma">쉼표 ,</option></select></div>
      <div class="foot"><button class="btn" data-action="close-modal">취소</button><button class="btn primary" id="imp-next">다음</button></div>`);
    $('#imp-delim').value = imp.delim;
    $('#imp-file').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try { toast('파일 읽는 중…'); const r = await parseFile(f); imp.sheets = r.sheets; imp.si = 0; imp.newName = f.name.replace(/\.[^.]+$/, ''); detectCols(); imp.step = 2; renderImport(); }
      catch (err) { toast('읽기 실패: ' + err.message, 4000); }
    };
    $('#imp-next').onclick = () => {
      const t = $('#imp-text').value; imp.delim = $('#imp-delim').value; imp.text = t;
      const rows = t.split(/\r?\n/).filter(l => l.trim()).map(l => splitLine(l, imp.delim));
      if (!rows.length) return toast('파일을 선택하거나 텍스트를 입력하세요');
      imp.sheets = [{ name: 'text', rows }]; imp.si = 0; if (!imp.newName) imp.newName = '붙여넣은 카드'; detectCols(); imp.step = 2; renderImport();
    };
    return;
  }
  const sheet = imp.sheets[imp.si]; const rows = sheet.rows; const ncol = Math.max(...rows.slice(0, 50).map(r => r.length), 2);
  const body = rows.slice(imp.header ? 1 : 0); const colOpts = sel => Array.from({ length: ncol }, (_, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${String.fromCharCode(65 + (i % 26))}열${imp.header && rows[0][i] ? ' (' + esc(String(rows[0][i]).slice(0, 12)) + ')' : ''}</option>`).join('');
  const prev = rows.slice(0, 6).map((r, ri) => `<tr>${Array.from({ length: ncol }, (_, i) => `<td style="${i === imp.colF ? 'background:rgba(79,109,245,.15)' : i === imp.colB ? 'background:rgba(22,163,74,.12)' : i === imp.colD ? 'background:rgba(245,158,11,.15)' : ''}">${esc(String(r[i] ?? '').slice(0, 40))}</td>`).join('')}</tr>`).join('');
  const decks = liveDecks(); const deckNames = imp.colD >= 0 ? new Set(body.map(r => String(r[imp.colD] ?? '').trim()).filter(Boolean)) : null;
  openModal(`<h3>열 선택 · ${body.length}개 행</h3>
    ${imp.sheets.length > 1 ? `<label class="field"><span>시트</span><select class="input" id="imp-sheet">${imp.sheets.map((s, i) => `<option value="${i}" ${i === imp.si ? 'selected' : ''}>${esc(s.name)} (${s.rows.length})</option>`).join('')}</select></label>` : ''}
    <div class="scrollx" style="margin-bottom:10px"><table class="preview"><thead><tr>${Array.from({ length: ncol }, (_, i) => `<th>${String.fromCharCode(65 + (i % 26))}</th>`).join('')}</tr></thead><tbody>${prev}</tbody></table></div>
    <label class="switch"><span>첫 행은 제목 (건너뛰기)</span><input type="checkbox" id="imp-header" ${imp.header ? 'checked' : ''}></label>
    <div class="row"><label class="field grow"><span>앞면 열</span><select class="input" id="imp-f">${colOpts(imp.colF)}</select></label><label class="field grow"><span>뒷면 열</span><select class="input" id="imp-b">${colOpts(imp.colB)}</select></label></div>
    <label class="field"><span>세트 나누기 열 (선택: 이 열의 값마다 세트가 생깁니다, 예: 과목)</span><select class="input" id="imp-d"><option value="-1">사용 안 함</option>${colOpts(imp.colD)}</select></label>
    ${imp.colD >= 0 ? `<div class="muted" style="margin-bottom:8px">→ ${deckNames.size}개 세트: ${esc([...deckNames].slice(0, 8).join(', '))}${deckNames.size > 8 ? ' …' : ''}</div>` : `
    <label class="field"><span>저장할 세트</span><select class="input" id="imp-target"><option value="new" ${imp.target === 'new' ? 'selected' : ''}>새 세트 만들기</option>${decks.map(d => `<option value="${d.id}" ${imp.target === d.id ? 'selected' : ''}>${esc(d.name)} (${liveCards(d).length}장)</option>`).join('')}</select></label>
    ${imp.target === 'new' ? `<label class="field"><span>새 세트 이름</span><input class="input" id="imp-name" value="${esc(imp.newName)}"></label>` : ''}`}
    <label class="switch"><span>앞면이 같은 카드는 건너뛰기</span><input type="checkbox" id="imp-dup" ${imp.skipDup ? 'checked' : ''}></label>
    <div class="foot"><button class="btn" id="imp-back">이전</button><button class="btn primary" id="imp-go">가져오기</button></div>`);
  const rerender = () => { imp.colF = +$('#imp-f').value; imp.colB = +$('#imp-b').value; imp.colD = +$('#imp-d').value; imp.header = $('#imp-header').checked; imp.skipDup = $('#imp-dup').checked; const t = $('#imp-target'); if (t) imp.target = t.value; const nm = $('#imp-name'); if (nm) imp.newName = nm.value; renderImport(); };
  ['#imp-f', '#imp-b', '#imp-d', '#imp-header', '#imp-target'].forEach(s => { const el = $(s); if (el) el.onchange = rerender; });
  const sh = $('#imp-sheet'); if (sh) sh.onchange = () => { imp.si = +sh.value; detectCols(); renderImport(); };
  $('#imp-back').onclick = () => { imp.step = 1; renderImport(); };
  $('#imp-go').onclick = () => {
    // read the live UI state at click time (never trust render-time closures)
    const nm = $('#imp-name'); if (nm) imp.newName = nm.value; imp.skipDup = $('#imp-dup').checked;
    imp.header = $('#imp-header').checked; imp.colF = +$('#imp-f').value; imp.colB = +$('#imp-b').value; imp.colD = +$('#imp-d').value;
    const t = $('#imp-target'); if (t) imp.target = t.value;
    const body = rows.slice(imp.header ? 1 : 0);
    const pairs = body.map(r => [r[imp.colF], r[imp.colB], imp.colD >= 0 ? String(r[imp.colD] ?? '').trim() : null]).filter(p => String(p[0] ?? '').trim() || String(p[1] ?? '').trim());
    let total = 0, created = 0, lastDeck = null;
    if (imp.colD >= 0) {
      const groups = new Map(); for (const p of pairs) { const k = p[2] || '(미분류)'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push([p[0], p[1]]); }
      for (const [name, ps] of groups) { let d = liveDecks().find(x => x.name === name); let id = d ? d.id : (created++, createDeck(name)); total += addCards(id, ps, imp.skipDup); lastDeck = id; }
    } else {
      let id = imp.target === 'new' ? (created++, createDeck(imp.newName || '새 세트')) : imp.target;
      total += addCards(id, pairs.map(p => [p[0], p[1]]), imp.skipDup); lastDeck = id;
    }
    const skipped = pairs.length - total;
    closeModal(); toast(`${total}장 가져옴${created ? ` · 세트 ${created}개 생성` : ''}${skipped > 0 ? ` · 중복 ${skipped}장 건너뜀` : ''}`, 3500);
    if (imp.colD >= 0 && created > 1) go('#/'); else if (lastDeck) go('#/deck/' + lastDeck);
    render();
  };
}
function detectCols() {
  const rows = imp.sheets[imp.si].rows; if (!rows.length) { imp.header = false; return; }
  imp.header = detectHeader(rows[0]);
  const hdr = rows[0].map(c => String(c ?? '').trim().toLowerCase());
  const find = ws => hdr.findIndex(h => ws.includes(h));
  const f = find(['앞면', '앞', '단어', '용어', '질문', '질환', 'front', 'term', 'word', 'question']);
  const b = find(['뒷면', '뒤', '뜻', '정답', '답', '항생제', 'back', 'definition', 'meaning', 'answer']);
  const dcol = find(['세트', '과목', '분류', '카테고리', 'deck', 'category', 'subject']);
  imp.colF = f >= 0 ? f : 0; imp.colB = b >= 0 ? b : (imp.colF === 0 ? 1 : 0); imp.colD = dcol >= 0 && dcol !== imp.colF && dcol !== imp.colB ? dcol : -1;
}

/* ---------- events ---------- */
let menuEl = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
function openMenu(items) {
  closeMenu(); menuEl = document.createElement('div'); menuEl.className = 'sheet';
  menuEl.innerHTML = items.map(it => `<button class="btn ghost block" style="justify-content:flex-start;${it.danger ? 'color:var(--no)' : ''}" data-menu="${it.id}">${it.label}</button>`).join('');
  document.body.appendChild(menuEl);
  menuEl.onclick = e => { const b = e.target.closest('[data-menu]'); if (!b) return; const it = items.find(x => x.id === b.dataset.menu); closeMenu(); it && it.run(); };
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action; const r = route(); const deckId = r.id;
  switch (a) {
    case 'go': go(el.dataset.to); break;
    case 'open-deck': listLimit = 200; deckSearch = ''; go('#/deck/' + el.dataset.id); break;
    case 'more': listLimit += 300; render(); break;
    case 'more-all': listLimit = 1e9; render(); break;
    case 'new-deck': promptModal('새 세트 이름', '', '만들기', v => { const id = createDeck(v); go('#/deck/' + id); }, '예: 항생제 정리'); break;
    case 'import': importModal(el.dataset.deck || null); break;
    case 'sync-pill': if (!settings.clientId) go('#/settings'); else if (!settings.signedIn) signIn(); else runSync(true); break;
    case 'sign-in': signIn(); break;
    case 'sign-out': signOut(); break;
    case 'sync-now': runSync(true); break;
    case 'toggle-help': showHelp = !showHelp; render(); break;
    case 'close-modal': closeModal(); break;
    case 'close-modal-bg': if (e.target === el) closeModal(); break;
    case 'opt': { const d = deckById(deckId); const o = sessOpts(deckId, liveCards(d).length); const k = el.dataset.k; o[k] = k === 'reverse' ? el.dataset.v === '1' : el.dataset.v; (sessions[deckId] || (sessions[deckId] = {})).opts = o; saveSessions(); render(); break; }
    case 'range': { const d = deckById(deckId); const o = sessOpts(deckId, liveCards(d).length); o.from = +el.dataset.from; o.to = +el.dataset.to; o.toAll = o.from === 1 && o.to === liveCards(d).length; (sessions[deckId] || (sessions[deckId] = {})).opts = o; saveSessions(); render(); break; }
    case 'start': startStudy(deckId); break;
    case 'resume': go('#/study/' + deckId); break;
    case 'restudy-wrong': { const s = sessions[deckId].cur; const wrong = s.ids.filter(i => s.res[i] === 0); const o = sessions[deckId].opts; sessions[deckId].cur = buildSession(deckId, o, wrong); saveSessions(); render(); break; }
    case 'flip': { const s = sessions[deckId].cur; s.back = !s.back; $('#flip').classList.toggle('back', s.back); saveSessions(); break; }
    case 'star': { const cid = el.dataset.id; const p = getP(deckId, cid) || {}; setP(deckId, cid, { s: p.s ? 0 : 1 }); if (r.name === 'study') { document.querySelectorAll('.face .star').forEach(b => { b.classList.toggle('on', !p.s); b.textContent = !p.s ? '★' : '☆'; }); } else render(); e.stopPropagation(); break; }
    case 'mark': { const s = sessions[deckId].cur; const cid = s.ids[s.i]; const v = +el.dataset.v; s.res[cid] = v; setP(deckId, cid, { k: v }); s.i++; s.back = false; saveSessions(); render(); break; }
    case 'next': { const s = sessions[deckId].cur; s.i++; s.back = false; saveSessions(); render(); break; }
    case 'prev': { const s = sessions[deckId].cur; if (s.i > 0) { s.i--; s.back = false; saveSessions(); render(); } break; }
    case 'study-menu': { const s = sessions[deckId].cur; openMenu([
      { id: 'flipdir', label: `↔ ${s.reverse ? '앞면부터 보기' : '뒷면부터 보기'}`, run: () => { s.reverse = !s.reverse; s.back = false; saveSessions(); render(); } },
      { id: 'reshuffle', label: '🔀 다시 섞기 (새 랜덤 시드)', run: () => { const rest = s.ids.slice(s.i); const seed = newSeed(); s.ids = s.ids.slice(0, s.i).concat(shuffleSeeded(rest, seed)); s.seed = seed; s.mode = 'shuffle'; s.back = false; saveSessions(); render(); toast('남은 카드를 다시 섞었습니다 (seed ' + seed + ')'); } },
      { id: 'seed', label: `🎲 현재 시드: ${s.seed}`, run: () => { promptModal('랜덤 시드 (같은 시드 = 같은 순서)', String(s.seed), '적용', v => { const seed = (parseInt(v, 10) >>> 0) || newSeed(); const d = data.decks[deckId]; const o = sessions[deckId].opts; const base = buildSession(deckId, Object.assign({}, o, { mode: 'seq' })); s.ids = shuffleSeeded(base.ids, seed); s.seed = seed; s.i = 0; s.back = false; s.res = {}; s.mode = 'shuffle'; saveSessions(); render(); }); } },
      { id: 'edit', label: '✏️ 이 카드 편집', run: () => editCardModal(deckId, s.ids[s.i]) },
      { id: 'restart', label: '⟲ 처음부터', run: () => startStudy(deckId) },
    ]); e.stopPropagation(); break; }
    case 'deck-menu': { const d = deckById(deckId); openMenu([
      { id: 'rename', label: '✏️ 이름 바꾸기', run: () => promptModal('세트 이름', d.name, '저장', v => { renameDeck(deckId, v); render(); }) },
      { id: 'export', label: '📤 엑셀로 내보내기', run: () => exportDeckXlsx(d).catch(err => toast(err.message)) },
      { id: 'reset', label: '⟲ 학습 기록 초기화', run: () => confirmModal('학습 기록 초기화', '알았음/모름 표시와 진행 중인 학습이 지워집니다. 별표는 유지됩니다.', '초기화', () => { const p = data.progress[deckId] || {}; for (const k in p) p[k] = Object.assign(p[k], { k: null, u: now() }); delete sessions[deckId]; saveSessions(); saveData(); render(); }) },
      { id: 'delete', label: '🗑 세트 삭제', danger: true, run: () => confirmModal('세트 삭제', `"${esc(d.name)}" 세트와 카드 ${liveCards(d).length}장을 삭제합니다.`, '삭제', () => { deleteDeck(deckId); go('#/'); }, true) },
    ]); e.stopPropagation(); break; }
    case 'edit-card': editCardModal(deckId, el.dataset.id); break;
    case 'card-menu': editCardModal(deckId, el.dataset.id); break;
    case 'backup': download(`amnesia-backup-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' })); break;
    case 'restore': { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json'; inp.onchange = async () => { try { const j = JSON.parse(await inp.files[0].text()); if (!j.decks) throw new Error('형식 오류'); data = mergeData(data, j); saveData(); render(); toast('복원 완료 (기존 데이터와 병합)'); } catch (err) { toast('복원 실패: ' + err.message); } }; inp.click(); break; }
    case 'wipe': confirmModal('전체 삭제', '이 기기의 모든 세트와 카드를 삭제합니다. 드라이브 동기화가 켜져 있으면 삭제도 동기화됩니다.', '모두 삭제', () => { for (const d of Object.values(data.decks)) { d.deleted = true; d.updated = now(); } sessions = {}; saveSessions(); saveData(); render(); }, true); break;
    case 'install': if (installPrompt) { installPrompt.prompt(); installPrompt = null; } break;
  }
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]'); if (!el) return;
  const k = el.dataset.change; const r = route(); const deckId = r.id;
  if (k === 'from' || k === 'to') { const d = deckById(deckId); const o = sessOpts(deckId, liveCards(d).length); o[k] = +el.value || 1; if (o.to < o.from) o.to = o.from; o.toAll = false; (sessions[deckId] || (sessions[deckId] = {})).opts = o; saveSessions(); render(); return; }
  if (k === 'chunk') { (sessions[deckId] || (sessions[deckId] = {})).chunk = +el.value; saveSessions(); render(); return; }
  if (k === 'theme') { settings.theme = el.value; applyTheme(); saveSettings(); return; }
  if (['autoSync', 'flipAnim', 'swipe', 'showHint'].includes(k)) { settings[k] = el.checked; saveSettings(); if (k === 'autoSync' && el.checked) scheduleSync(); }
});
document.addEventListener('input', e => {
  const el = e.target.closest('[data-input]'); if (!el) return;
  if (el.dataset.input === 'clientId') { settings.clientId = el.value.trim(); sync.client = null; saveSettings(); const b = document.querySelector('[data-action="sign-in"]'); if (b) b.disabled = !settings.clientId; setStatus('idle'); }
  if (el.dataset.input === 'search') { deckSearch = el.value; clearTimeout(window._st); window._st = setTimeout(() => { const pos = el.selectionStart; render(); const n = document.querySelector('[data-input="search"]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }, 200); }
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-form="add-card"]'); if (!f) return; e.preventDefault();
  const deckId = route().id; const fv = f.f.value, bv = f.b.value; if (!fv.trim() && !bv.trim()) return;
  addCards(deckId, [[fv, bv]]); f.reset(); render(); const n = document.querySelector('[data-form="add-card"] [name=f]'); if (n) n.focus(); toast(`${liveCards(data.decks[deckId]).length}번으로 추가됨`);
});
document.addEventListener('keydown', e => {
  if (route().name !== 'study' || $('#modal-root').innerHTML) return;
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  const map = { ' ': 'flip', 'Enter': 'flip', 'ArrowLeft': 'prev', 'ArrowRight': 'next', '1': 'mark0', '2': 'mark1', 'ArrowUp': 'flip', 'ArrowDown': 'flip' };
  const a = map[e.key]; if (!a) return; e.preventDefault();
  const sel = a.startsWith('mark') ? `[data-action="mark"][data-v="${a.slice(4)}"]` : `[data-action="${a}"]`;
  const b = document.querySelector(sel); if (b && !b.disabled) b.click();
});

/* swipe + per-view setup */
function afterRender(r) {
  closeMenu();
  if (r.name === 'study' && settings.swipe) {
    const flip = $('#flip'); if (!flip) return; let sx = 0, sy = 0, t0 = 0;
    flip.addEventListener('touchstart', e => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; t0 = now(); }, { passive: true });
    flip.addEventListener('touchend', e => {
      const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 60 && now() - t0 < 600) { const b = document.querySelector(`[data-action="${dx < 0 ? 'next' : 'prev'}"]`); if (b && !b.disabled) b.click(); }
    }, { passive: true });
  }
  if (r.name === 'settings' && installPrompt) { const row = $('#install-row'); if (row) row.classList.remove('hidden'); }
}

/* ---------- boot ---------- */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; const row = $('#install-row'); if (row) row.classList.remove('hidden'); });
function applyTheme() { document.documentElement.setAttribute('data-theme', settings.theme === 'auto' ? '' : settings.theme); if (settings.theme === 'auto') document.documentElement.removeAttribute('data-theme'); }
applyTheme();
render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => { });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && settings.autoSync) runSync(false); });
if (settings.clientId && settings.signedIn && settings.autoSync) setTimeout(() => runSync(false), 800);
