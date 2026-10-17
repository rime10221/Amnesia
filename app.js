'use strict';
/* =====================================================================
   Amnesia 낱말카드 v2
   folders(단원) > decks(세트: 직접 입력 / 엑셀 파일) > cards (text + optional images)
   sections: utils / storage / model / images / sync / import-export /
             views / study / events / boot
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
function fontClass(t, hasImg) { const n = (t || '').length; if (hasImg) return n <= 40 ? 'fs-l' : 'fs-m'; return n <= 18 ? 'fs-xl' : n <= 60 ? 'fs-l' : n <= 160 ? 'fs-m' : 'fs-s'; }
function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
const key = (d, c) => d + '|' + c, splitKey = k => k.split('|');

/* ---------- storage ---------- */
const LS = { data: 'amnesia.data.v1', set: 'amnesia.settings.v1', sess: 'amnesia.sessions.v2' };
function lsLoad(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function lsSave(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast('저장 실패: 저장 공간이 부족합니다'); return false; } }

let data = lsLoad(LS.data, null) || { decks: {}, folders: {}, progress: {}, images: {} };
data.folders ||= {}; data.progress ||= {}; data.images ||= {};
const DEFAULT_CLIENT_ID = '83549191023-4v8ggp4pbt9q8oen511nk0cvv2jo9c4a.apps.googleusercontent.com'; // GCP project amnesia-511913 (public identifier)
let settings = Object.assign({
  clientId: DEFAULT_CLIENT_ID, autoSync: true, theme: 'auto', flipAnim: true, swipe: true, showHint: true,
  signedIn: false, token: null, sync: { folderId: null, imgFolderId: null, fileId: null, lastSync: null, email: null }
}, lsLoad(LS.set, {}));
settings.sync.imgFolderId ??= null;
let sessions = lsLoad(LS.sess, {});

function saveData() { lsSave(LS.data, data); scheduleSync(); }
function saveSettings() { lsSave(LS.set, settings); }
function saveSessions() { lsSave(LS.sess, sessions); }

/* ---------- model ---------- */
const liveDecks = () => Object.values(data.decks).filter(d => !d.deleted).sort((a, b) => (a.order ?? a.created) - (b.order ?? b.created));
const liveFolders = () => Object.values(data.folders).filter(f => !f.deleted).sort((a, b) => (a.order ?? a.created) - (b.order ?? b.created));
const liveCards = d => Object.values(d.cards).filter(c => !c.deleted).sort((a, b) => a.pos - b.pos || a.created - b.created);
const deckById = id => { const d = data.decks[id]; return d && !d.deleted ? d : null; };
const folderById = id => { const f = data.folders[id]; return f && !f.deleted ? f : null; };
const folderDecks = fid => liveDecks().filter(d => d.folderId === fid);
const MAX_DEPTH = 2;
const effParent = f => (f.parentId && folderById(f.parentId)) ? f.parentId : null;
const childFolders = pid => liveFolders().filter(f => effParent(f) === (pid || null));
function folderDepth(id) { let d = 1, f = folderById(id); while (f && effParent(f)) { d++; f = folderById(effParent(f)); } return d; }
function folderDecksDeep(fid) { return folderDecks(fid).concat(...childFolders(fid).map(c => folderDecksDeep(c.id))); }
function folderPath(id) { const out = []; let f = folderById(id); while (f) { out.unshift(f); f = effParent(f) ? folderById(effParent(f)) : null; } return out; }
function folderOptions(selectedId, excludeId = null, maxDepth = MAX_DEPTH) {
  // <option>s for every folder (indented), honoring the depth limit
  const rows = [];
  const walk = (pid, depth, prefix) => { for (const f of childFolders(pid)) { if (f.id === excludeId) continue; if (depth <= maxDepth) rows.push(`<option value="${f.id}" ${selectedId === f.id ? 'selected' : ''}>${prefix}${esc(f.name)}</option>`); if (depth < maxDepth) walk(f.id, depth + 1, prefix + '　└ '); } };
  walk(null, 1, '📁 '); return rows.join('');
}
const rootDecks = () => liveDecks().filter(d => !d.folderId || !folderById(d.folderId));
function maxPos(d) { let m = 0; for (const c of Object.values(d.cards)) if (!c.deleted && c.pos > m) m = c.pos; return m; }

function createFolder(name, parentId = null) { if (parentId && folderDepth(parentId) >= MAX_DEPTH) parentId = effParent(folderById(parentId)); const id = uid(); const t = now(); data.folders[id] = { id, name: name.trim() || '새 폴더', created: t, updated: t, parentId: parentId || null }; saveData(); return id; }
function moveFolder(id, parentId) { const f = data.folders[id]; if (!f) return; if (parentId === id) return; f.parentId = parentId || null; f.updated = now(); saveData(); }
function renameFolder(id, name) { const f = data.folders[id]; if (!f) return; f.name = name.trim() || f.name; f.updated = now(); saveData(); }
function deleteFolder(id, withDecks) {
  const f = data.folders[id]; if (!f) return;
  for (const c of childFolders(id)) { if (withDecks) deleteFolder(c.id, true); else { c.parentId = null; c.updated = now(); } }
  for (const d of folderDecks(id)) { if (withDecks) { d.deleted = true; } else { d.folderId = null; } d.updated = now(); }
  f.deleted = true; f.updated = now(); delete sessions['folder:' + id]; saveSessions(); saveData();
}
function createDeck(name, folderId = null) { const id = uid(); const t = now(); data.decks[id] = { id, name: name.trim() || '새 세트', created: t, updated: t, folderId: folderId || null, cards: {} }; saveData(); return id; }
function renameDeck(id, name) { const d = data.decks[id]; if (!d) return; d.name = name.trim() || d.name; d.updated = now(); saveData(); }
function moveDeck(id, folderId) { const d = data.decks[id]; if (!d) return; d.folderId = folderId || null; d.updated = now(); saveData(); }
function deleteDeck(id) { const d = data.decks[id]; if (!d) return; d.deleted = true; d.updated = now(); delete sessions['deck:' + id]; saveSessions(); saveData(); }
function addCards(deckId, items, skipDup = false) {
  // items: [[front, back]] or [{f,b,fi,bi}]
  const d = data.decks[deckId]; if (!d) return 0;
  const existing = new Set(skipDup ? liveCards(d).map(c => c.f.trim()) : []);
  let pos = maxPos(d) + 1, n = 0; const t = now();
  for (const it of items) {
    const o = Array.isArray(it) ? { f: it[0], b: it[1] } : it;
    const ff = String(o.f ?? '').trim(), bb = String(o.b ?? '').trim();
    if (!ff && !bb && !o.fi && !o.bi) continue;
    if (skipDup && ff && existing.has(ff)) continue;
    const id = uid(); const c = { id, f: ff, b: bb, pos: pos++, created: t + n, updated: t + n };
    if (o.fi) c.fi = o.fi; if (o.bi) c.bi = o.bi;
    d.cards[id] = c; existing.add(ff); n++;
  }
  if (n) { d.updated = now(); saveData(); }
  return n;
}
function updateCard(deckId, cardId, patch) { const d = data.decks[deckId]; const c = d && d.cards[cardId]; if (!c) return; Object.assign(c, patch); if (patch.f != null) c.f = c.f.trim(); if (patch.b != null) c.b = c.b.trim(); if (!c.fi) delete c.fi; if (!c.bi) delete c.bi; c.updated = now(); d.updated = c.updated; saveData(); }
function deleteCard(deckId, cardId) { const d = data.decks[deckId]; const c = d && d.cards[cardId]; if (!c) return; c.deleted = true; c.updated = now(); d.updated = c.updated; saveData(); }
function moveCard(deckId, cardId, dir) { const d = data.decks[deckId]; const list = liveCards(d); const i = list.findIndex(c => c.id === cardId); const j = i + dir; if (i < 0 || j < 0 || j >= list.length) return; const a = list[i], b = list[j]; [a.pos, b.pos] = [b.pos, a.pos]; a.updated = b.updated = d.updated = now(); saveData(); }
function getP(deckId, cardId) { return (data.progress[deckId] || {})[cardId]; }
function setP(deckId, cardId, patch) { const p = data.progress[deckId] || (data.progress[deckId] = {}); p[cardId] = Object.assign(p[cardId] || { k: null, s: 0 }, patch, { u: now() }); saveData(); }
function statsFor(deckIds) {
  let total = 0, ok = 0, no = 0, star = 0;
  for (const id of deckIds) { const d = deckById(id); if (!d) continue; for (const c of liveCards(d)) { total++; const p = getP(id, c.id); if (p) { if (p.k === 1) ok++; else if (p.k === 0) no++; if (p.s) star++; } } }
  return { total, ok, no, star, fresh: total - ok - no };
}
function resetProgress(deckIds, keepStars = true) {
  for (const id of deckIds) { const p = data.progress[id]; if (!p) continue; for (const cid in p) p[cid] = Object.assign(p[cid], { k: null, s: keepStars ? p[cid].s : 0, u: now() }); }
  for (const k of Object.keys(sessions)) { const [t, id] = k.split(':'); if ((t === 'deck' && deckIds.includes(id)) || t === 'folder') delete sessions[k].cur; }
  saveSessions(); saveData();
}

/* scopes: what is being studied (one deck or a whole folder) */
function getScope(type, id) {
  if (type === 'deck') { const d = deckById(id); return d && { type, id, name: d.name, deckIds: [id] }; }
  const f = folderById(id); return f && { type, id, name: f.name, deckIds: folderDecksDeep(id).map(d => d.id) };
}
function scopeCards(scope, inc) { const out = []; for (const did of scope.deckIds) { if (inc && !inc.includes(did)) continue; const d = deckById(did); for (const c of liveCards(d)) out.push({ d: did, c }); } return out; }
const skey = s => s.type + ':' + s.id;

/* ---------- merge (sync) ---------- */
function newer(a, b, f = 'updated') { return !a ? b : !b ? a : ((a[f] || 0) >= (b[f] || 0) ? a : b); }
function mergeData(local, remote) {
  if (!remote) return JSON.parse(JSON.stringify(local));
  const out = { decks: {}, folders: {}, progress: {}, images: {} };
  for (const id of new Set([...Object.keys(local.decks || {}), ...Object.keys(remote.decks || {})])) {
    const a = local.decks[id], b = remote.decks[id];
    if (!a || !b) { out.decks[id] = JSON.parse(JSON.stringify(a || b)); continue; }
    const base = newer(a, b);
    const m = { id, name: base.name, created: Math.min(a.created, b.created), updated: Math.max(a.updated, b.updated), folderId: base.folderId || null, cards: {} };
    if (base.deleted) m.deleted = true; if (base.order != null) m.order = base.order;
    for (const cid of new Set([...Object.keys(a.cards || {}), ...Object.keys(b.cards || {})])) m.cards[cid] = JSON.parse(JSON.stringify(newer(a.cards[cid], b.cards[cid])));
    out.decks[id] = m;
  }
  for (const id of new Set([...Object.keys(local.folders || {}), ...Object.keys(remote.folders || {})])) out.folders[id] = JSON.parse(JSON.stringify(newer(local.folders[id], remote.folders[id])));
  for (const id of new Set([...Object.keys(local.progress || {}), ...Object.keys(remote.progress || {})])) {
    const a = local.progress[id] || {}, b = remote.progress[id] || {}; const m = {};
    for (const cid of new Set([...Object.keys(a), ...Object.keys(b)])) m[cid] = Object.assign({}, newer(a[cid], b[cid], 'u'));
    out.progress[id] = m;
  }
  for (const id of new Set([...Object.keys(local.images || {}), ...Object.keys(remote.images || {})])) { const a = local.images[id], b = remote.images[id]; out.images[id] = Object.assign({}, newer(a, b)); if (!out.images[id].fileId) out.images[id].fileId = (a && a.fileId) || (b && b.fileId) || null; }
  return out;
}

/* ---------- images (IndexedDB blobs + Drive files) ---------- */
const idb = {
  db: null,
  open() { return this.db ? Promise.resolve(this.db) : new Promise((res, rej) => { const r = indexedDB.open('amnesia-images', 1); r.onupgradeneeded = () => r.result.createObjectStore('img'); r.onsuccess = () => { this.db = r.result; res(this.db); }; r.onerror = () => rej(r.error); }); },
  async get(id) { try { const db = await this.open(); return await new Promise((res, rej) => { const t = db.transaction('img').objectStore('img').get(id); t.onsuccess = () => res(t.result || null); t.onerror = () => rej(t.error); }); } catch (e) { return null; } },
  async put(id, blob) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('img', 'readwrite').objectStore('img').put(blob, id); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); },
  async del(id) { try { const db = await this.open(); await new Promise((res) => { const t = db.transaction('img', 'readwrite').objectStore('img').delete(id); t.onsuccess = res; t.onerror = res; }); } catch (e) { } },
};
const urlCache = new Map();
function compressImage(file, max = 1400, q = 0.82) {
  return new Promise((res, rej) => {
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(u); let { width: w, height: h } = img; const s = Math.min(1, max / Math.max(w, h)); w = Math.round(w * s); h = Math.round(h * s); const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(img, 0, 0, w, h); cv.toBlob(b => b ? res(b) : rej(new Error('이미지 변환 실패')), 'image/jpeg', q); };
    img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('이미지를 읽을 수 없습니다')); }; img.src = u;
  });
}
function pickImage() {
  return new Promise(res => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.onchange = async () => { const f = inp.files[0]; if (!f) return res(null); try { toast('사진 처리 중…'); const blob = await compressImage(f); const id = uid(); await idb.put(id, blob); data.images[id] = { updated: now(), fileId: null, size: blob.size }; saveData(); res(id); } catch (e) { toast(e.message, 3000); res(null); } }; inp.click(); });
}
async function imageUrl(id) {
  if (!id) return null; if (urlCache.has(id)) return urlCache.get(id);
  let blob = await idb.get(id);
  if (!blob) { const meta = data.images[id]; if (meta && meta.fileId && settings.signedIn) { try { const r = await gfetch(`${DRIVE}/files/${meta.fileId}?alt=media`); blob = await r.blob(); await idb.put(id, blob); } catch (e) { return null; } } }
  if (!blob) return null; const u = URL.createObjectURL(blob); urlCache.set(id, u); return u;
}
function hydrateImages(root = document) {
  root.querySelectorAll('img[data-img]').forEach(async el => { const u = await imageUrl(el.dataset.img); if (u) { el.src = u; el.classList.remove('hidden'); } else el.closest('.imgwrap')?.classList.add('missing'); });
}
async function driveImgFolder() {
  const parent = await driveFolder();
  if (settings.sync.imgFolderId) return settings.sync.imgFolderId;
  const q = encodeURIComponent(`name='images' and mimeType='application/vnd.google-apps.folder' and '${parent}' in parents and trashed=false`);
  const found = (await (await gfetch(`${DRIVE}/files?q=${q}&fields=files(id)`)).json()).files;
  let id = found && found[0] && found[0].id;
  if (!id) { const r = await gfetch(`${DRIVE}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'images', mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) }); id = (await r.json()).id; }
  settings.sync.imgFolderId = id; saveSettings(); return id;
}
async function uploadPendingImages() {
  const pending = Object.entries(data.images).filter(([, m]) => !m.fileId);
  if (!pending.length) return false; let changed = false;
  const folder = await driveImgFolder();
  for (const [id, m] of pending) {
    const blob = await idb.get(id); if (!blob) continue;
    const boundary = 'amnesiaimg' + now();
    const meta = JSON.stringify({ name: id + '.jpg', parents: [folder] });
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`, blob, `\r\n--${boundary}--`]);
    const r = await gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
    m.fileId = (await r.json()).id; m.updated = now(); changed = true;
  }
  if (changed) lsSave(LS.data, data);
  return changed;
}

/* ---------- Google Drive sync ---------- */
const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
const DRIVE = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'Amnesia', FILE = 'amnesia-decks.json';
const sync = { status: 'idle', msg: '', busy: false, timer: null, pending: false, needLogin: false, justLoggedIn: false };

function syncStatus() {
  if (!settings.clientId) return { cls: '', text: '동기화 꺼짐' };
  if (sync.status === 'busy') return { cls: 'busy', text: '동기화 중…' };
  if (sync.status === 'error') return { cls: 'err', text: sync.needLogin ? '탭하여 다시 로그인' : '동기화 오류' };
  if (!settings.signedIn) return { cls: '', text: '로그인 필요' };
  return { cls: 'ok', text: settings.sync.lastSync ? '동기화 ' + fmtTime(settings.sync.lastSync) : '로그인됨' };
}
function setStatus(s, msg = '') { sync.status = s; sync.msg = msg; document.querySelectorAll('[data-sync-pill]').forEach(el => { const st = syncStatus(); el.className = 'pill ' + st.cls; el.innerHTML = `<i class="dot"></i>${esc(st.text)}`; }); const d = $('#sync-detail'); if (d) d.textContent = msg || (settings.sync.email ? settings.sync.email : ''); }
/* --- OAuth: redirect/iframe implicit flow (no popups, token kept in localStorage until 로그아웃) --- */
const AUTH_EP = 'https://accounts.google.com/o/oauth2/v2/auth';
const REDIRECT_URI = location.origin + location.pathname;
function authUrl(opts = {}) {
  if (!settings.clientId) throw new Error('설정에서 Google 클라이언트 ID를 먼저 입력하세요');
  const p = new URLSearchParams({ client_id: settings.clientId, redirect_uri: REDIRECT_URI, response_type: 'token', scope: SCOPES, include_granted_scopes: 'true', state: JSON.stringify(Object.assign({ r: location.hash || '#/' }, opts.state || {})) });
  if (settings.sync.email) p.set('login_hint', settings.sync.email);
  p.set('prompt', opts.silent ? 'none' : (settings.sync.email ? '' : 'select_account'));
  return AUTH_EP + '?' + p.toString();
}
function tokenValid() { return settings.token && settings.token.v && now() < settings.token.exp; }
function storeToken(v, expiresIn) { settings.token = { v, exp: now() + (Math.max(60, (parseInt(expiresIn, 10) || 3600)) - 90) * 1000 }; settings.signedIn = true; saveSettings(); }
/* called at boot: consume #access_token=... returned by Google (top window or hidden iframe) */
function handleAuthReturn() {
  const h = location.hash; if (!/(^|[#&])(access_token|error)=/.test(h)) return null;
  const p = new URLSearchParams(h.replace(/^#/, '')); let st = {}; try { st = JSON.parse(p.get('state') || '{}'); } catch (e) { }
  const result = p.get('access_token') ? { ok: true, token: p.get('access_token'), expiresIn: p.get('expires_in') } : { ok: false, error: p.get('error') || 'unknown' };
  if (st.iframe && window.parent !== window) { window.parent.postMessage(Object.assign({ amnesiaAuth: true, state: st.iframe }, result), location.origin); return { iframe: true }; }
  history.replaceState(null, '', location.pathname + (st.r && st.r.startsWith('#') ? st.r : '#/'));
  if (result.ok) { storeToken(result.token, result.expiresIn); sync.justLoggedIn = true; }
  else { sync.needLogin = true; sync.status = 'error'; sync.msg = result.error === 'interaction_required' || result.error === 'login_required' || result.error === 'consent_required' ? '다시 로그인이 필요합니다' : '로그인 실패: ' + result.error; }
  return result;
}
function silentIframe() {
  return new Promise(res => {
    const st = uid(); const f = document.createElement('iframe'); f.style.display = 'none'; f.setAttribute('aria-hidden', 'true');
    const done = v => { clearTimeout(to); window.removeEventListener('message', onMsg); f.remove(); res(v); };
    const to = setTimeout(() => done(null), 8000);
    const onMsg = e => { if (e.origin !== location.origin || !e.data || !e.data.amnesiaAuth || e.data.state !== st) return; done(e.data); };
    window.addEventListener('message', onMsg);
    try { f.src = authUrl({ silent: true, state: { iframe: st } }); } catch (e) { return done(null); }
    document.body.appendChild(f);
  });
}
let silentInFlight = null;
async function getToken(interactive) {
  if (tokenValid()) return settings.token.v;
  if (interactive) { saveSettings(); location.href = authUrl({ silent: false }); return new Promise(() => { }); }
  if (!silentInFlight) silentInFlight = silentIframe().finally(() => { silentInFlight = null; });
  const r = await silentInFlight;
  if (r && r.ok) { storeToken(r.token, r.expiresIn); sync.needLogin = false; return settings.token.v; }
  throw new Error(r && r.error ? 'login_required: ' + r.error : 'login_required');
}
async function gfetch(url, opt = {}, interactive = false) {
  const tok = await getToken(interactive);
  const r = await fetch(url, Object.assign({}, opt, { headers: Object.assign({ Authorization: 'Bearer ' + tok }, opt.headers || {}) }));
  if (r.status === 401) { settings.token = null; saveSettings(); throw new Error('인증이 만료되었습니다. 다시 로그인하세요'); }
  if (!r.ok) { let t = ''; try { t = (await r.json()).error.message; } catch (e) { t = r.statusText; } throw new Error('Drive 오류: ' + t); }
  return r;
}
async function signIn() {
  setStatus('busy', '로그인 중…');
  try { await getToken(true); } catch (e) { setStatus('error', e.message); toast(e.message, 4000); render(); }
}
async function afterLogin() {
  try {
    const me = await (await gfetch('https://www.googleapis.com/oauth2/v3/userinfo')).json();
    settings.sync.email = me.email || settings.sync.email || null; saveSettings();
    setStatus('idle'); toast('로그인됨: ' + (settings.sync.email || '')); render();
    await runSync(true);
  } catch (e) { setStatus('error', e.message); toast(e.message, 4000); }
}
function signOut() {
  const t = settings.token && settings.token.v;
  if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST' }).catch(() => { });
  settings.token = null; settings.signedIn = false; sync.needLogin = false; settings.sync = { folderId: null, imgFolderId: null, fileId: null, lastSync: null, email: null }; saveSettings(); setStatus('idle'); render();
}
async function driveFolder() {
  if (settings.sync.folderId) { try { const r = await gfetch(`${DRIVE}/files/${settings.sync.folderId}?fields=id,trashed`); const j = await r.json(); if (!j.trashed) return j.id; } catch (e) { } settings.sync.folderId = null; settings.sync.imgFolderId = null; }
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
  if (fileId) return (await gfetch(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text })).json();
  const boundary = 'amnesia' + now();
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE, parents: [folderId], mimeType: 'application/json' })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
  return (await gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body })).json();
}
async function runSync(interactive = false) {
  if (!settings.clientId || !settings.signedIn) return;
  if (!interactive && sync.needLogin) return; // silent refresh failed earlier: wait for the user to tap the pill
  if (sync.busy) { sync.pending = true; return; }
  sync.busy = true; setStatus('busy');
  try {
    const folderId = await driveFolder();
    try { if (await uploadPendingImages()) { } } catch (e) { console.warn('image upload', e); }
    const file = await driveFile(folderId);
    let remote = null;
    if (file) { const r = await gfetch(`${DRIVE}/files/${file.id}?alt=media`); try { remote = await r.json(); } catch (e) { remote = null; } if (remote && !remote.decks) remote = null; if (remote) { remote.folders ||= {}; remote.progress ||= {}; remote.images ||= {}; } }
    const merged = mergeData(data, remote);
    const localChanged = stableStr(merged) !== stableStr(data);
    const remoteChanged = !remote || stableStr(merged) !== stableStr(remote);
    if (localChanged) { data = merged; lsSave(LS.data, data); }
    if (remoteChanged) { const j = await driveUpload(folderId, file && file.id, JSON.stringify(merged)); settings.sync.fileId = j.id; }
    else settings.sync.fileId = file.id;
    settings.sync.lastSync = now(); saveSettings(); setStatus('idle');
    if (localChanged) { render(); toast('드라이브에서 변경사항을 가져왔습니다'); }
    else if (interactive) toast('동기화 완료');
    sync.needLogin = false;
  } catch (e) {
    console.warn(e);
    if (/만료|login_required|access_denied|interaction_required|consent_required/.test(e.message)) sync.needLogin = true;
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
const HEADER_WORDS = ['단어', '뜻', '앞', '뒤', '앞면', '뒷면', '질문', '답', '정답', '용어', 'front', 'back', 'term', 'definition', 'word', 'meaning', 'question', 'answer', '질환', '항생제', '제목', 'title', '세트', 'deck', '과목', '분류', '카테고리', '단원', '폴더'];
function detectHeader(row) { return row.some(c => HEADER_WORDS.includes(String(c ?? '').trim().toLowerCase())); }
function splitLine(line, delim) {
  const cut = (re) => { const m = line.match(re); if (!m) return [line, '']; const i = line.indexOf(m[0]); return [line.slice(0, i), line.slice(i + m[0].length)]; };
  if (delim === 'tab') return cut(/\t/);
  if (delim === 'colon') return cut(/\s+:\s+|\s*：\s*|\s*:\s*/);
  if (delim === 'dash') return cut(/\s+-\s+|\s*–\s*|\s*—\s*/);
  if (delim === 'comma') return cut(/,/);
  if (line.includes('\t')) return cut(/\t/);
  if (/\s+:\s+/.test(line)) return cut(/\s+:\s+/);
  if (/\s+-\s+/.test(line)) return cut(/\s+-\s+/);
  if (/:/.test(line)) return cut(/\s*:\s*/);
  if (/,/.test(line)) return cut(/,/);
  return [line, ''];
}
async function parseFile(file) {
  const name = file.name.toLowerCase();
  if (/\.(xlsx|xlsm|xls|csv)$/.test(name)) {
    await ensureXlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', codepage: 65001 });
    return { sheets: wb.SheetNames.map(n => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: false }).filter(r => r.some(c => String(c).trim() !== '')) })) };
  }
  const text = await file.text();
  return { sheets: [{ name: 'text', rows: text.split(/\r?\n/).filter(l => l.trim()).map(l => splitLine(l, 'auto')) }] };
}
async function exportXlsx(name, deckIds) {
  await ensureXlsx();
  const wb = XLSX.utils.book_new();
  for (const id of deckIds) {
    const d = deckById(id); if (!d) continue;
    const ws = XLSX.utils.aoa_to_sheet([['앞면', '뒷면']].concat(liveCards(d).map(c => [c.f, c.b]))); ws['!cols'] = [{ wch: 40 }, { wch: 70 }];
    XLSX.utils.book_append_sheet(wb, ws, d.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'cards');
  }
  XLSX.writeFile(wb, `${name}.xlsx`);
}

/* ---------- router / render ---------- */
const app = $('#app');
function route() { const p = (location.hash.slice(1) || '/').split('/').filter(Boolean).map(decodeURIComponent); return { name: p[0] || 'home', a: p[1] || null, b: p[2] || null }; }
function go(h) { location.hash = h; }
function render() {
  const r = route();
  let html;
  if (r.name === 'folder') html = viewFolder(r.a);
  else if (r.name === 'deck') html = viewDeck(r.a);
  else if (r.name === 'study') html = viewStudy(r.a, r.b);
  else if (r.name === 'settings') html = viewSettings();
  else html = viewHome();
  app.innerHTML = html;
  afterRender(r); hydrateImages(app);
}
window.addEventListener('hashchange', render);
function pill() { const st = syncStatus(); return `<button class="pill ${st.cls}" data-sync-pill data-action="sync-pill"><i class="dot"></i>${esc(st.text)}</button>`; }
function topbar(title, left, right = '') { return `<div class="topbar">${left || ''}<h1>${esc(title)}</h1>${right}</div>`; }
function barHtml(s) { const ok = s.total ? Math.round(s.ok / s.total * 100) : 0, no = s.total ? Math.round(s.no / s.total * 100) : 0; return `<div class="bar multi"><i style="width:${ok}%"></i><i class="no" style="width:${no}%"></i></div>`; }
function folderRow(f) { const ids = folderDecksDeep(f.id).map(d => d.id); const s = statsFor(ids); const subs = childFolders(f.id).length; return `<button class="deck folder" data-action="go" data-to="#/folder/${f.id}"><span class="dicon">📁</span><div class="grow"><div class="name">${esc(f.name)}</div><div class="meta">${subs ? `하위 폴더 ${subs}개 · ` : ''}세트 ${ids.length}개 · ${s.total}장 · 알았음 ${s.ok} · 모름 ${s.no}</div>${barHtml(s)}</div><span class="muted">›</span></button>`; }
function deckRow(d, idx) { const s = statsFor([d.id]); return `<button class="deck" data-action="go" data-to="#/deck/${d.id}"><span class="dicon">${idx != null ? idx + 1 : '🗂'}</span><div class="grow"><div class="name">${esc(d.name)}</div><div class="meta">${s.total}장 · 알았음 ${s.ok} · 모름 ${s.no}${s.star ? ' · ★' + s.star : ''}</div>${barHtml(s)}</div><span class="muted">›</span></button>`; }

/* ---------- view: home ---------- */
function viewHome() {
  const folders = childFolders(null), decks = rootDecks();
  const fl = folders.map(folderRow).join('');
  const dl = decks.map(d => deckRow(d)).join('');
  const empty = !folders.length && !decks.length ? `<div class="empty"><div class="big">📁</div>아직 아무것도 없습니다.<br>오른쪽 아래 + 버튼으로 폴더(단원)를 만들고<br>그 안에 직접 입력하거나 엑셀을 가져오세요.</div>` : '';
  return topbar('Amnesia', '', `${pill()}<button class="iconbtn" data-action="go" data-to="#/settings" title="설정">⚙️</button>`) +
    `<div class="page">${fl}${dl}${empty}</div>
    <button class="fab" data-action="fab" title="추가">+</button>`;
}

/* ---------- study options shared by folder & deck pages ---------- */
let listLimit = 200, deckSearch = '';
function sessOpts(scope) {
  const s = sessions[skey(scope)] || {}; const o = Object.assign({ mode: 'seq', from: 1, to: 1, toAll: true, filter: 'all', reverse: false, inc: null }, s.opts || {});
  if (o.inc) o.inc = o.inc.filter(id => scope.deckIds.includes(id));
  const total = scopeCards(scope, o.inc).length;
  o.from = clamp(o.from, 1, Math.max(1, total)); if (o.toAll || o.to == null) o.to = total; o.to = clamp(o.to, o.from, Math.max(1, total));
  return o;
}
function filterItems(items, o) {
  if (o.filter === 'unknown') return items.filter(x => !(getP(x.d, x.c.id) || {}).k);
  if (o.filter === 'wrong') return items.filter(x => (getP(x.d, x.c.id) || {}).k === 0);
  if (o.filter === 'star') return items.filter(x => (getP(x.d, x.c.id) || {}).s);
  return items;
}
function countForOpts(scope, o) { return filterItems(scopeCards(scope, o.inc).slice(o.from - 1, o.to), o).length; }
function studyPanel(scope) {
  const o = sessOpts(scope); const all = scopeCards(scope, o.inc); const total = all.length; const n = countForOpts(scope, o);
  const sess = sessions[skey(scope)] && sessions[skey(scope)].cur; const canResume = sess && sess.i < sess.ids.length && sess.ids.length > 0;
  const chunk = total > 60 ? (sessions[skey(scope)] && sessions[skey(scope)].chunk) || 50 : 0;
  let chunks = '';
  if (chunk) { const parts = []; for (let a = 1; a <= total; a += chunk) { const b = Math.min(a + chunk - 1, total); parts.push(`<button class="chip ${o.from === a && o.to === b ? 'on' : ''}" data-action="range" data-from="${a}" data-to="${b}">${a}–${b}</button>`); } chunks = `<div class="row" style="margin-top:8px"><span class="muted">묶음</span><select class="input" style="width:auto;min-height:34px;padding:4px 8px" data-change="chunk">${[20, 30, 50, 100].map(v => `<option ${chunk == v ? 'selected' : ''}>${v}</option>`).join('')}</select><span class="muted">개씩</span></div><div class="chips" style="margin-top:8px">${parts.join('')}</div>`; }
  let incHtml = '';
  if (scope.type === 'folder' && scope.deckIds.length > 1) {
    incHtml = `<div class="muted" style="margin:10px 0 6px">포함할 세트</div><div class="chips" style="margin-bottom:6px">${scope.deckIds.map(id => { const d = deckById(id); const on = !o.inc || o.inc.includes(id); const sub = scope.type === 'folder' && d.folderId !== scope.id && folderById(d.folderId) ? esc(folderById(d.folderId).name) + ' › ' : ''; return `<button class="chip ${on ? 'on' : ''}" data-action="inc" data-id="${id}">${sub}${esc(d.name)} (${liveCards(d).length})</button>`; }).join('')}<button class="chip" data-action="inc-all">모두</button></div>`;
  }
  const cnt = f => countForOpts(scope, Object.assign({}, o, { filter: f }));
  return `<div class="card-box">
    <h2>학습 설정 <span class="muted" style="font-weight:400">· ${total}장</span></h2>
    ${incHtml}
    <div class="chips" style="margin-bottom:10px">
      <button class="chip ${o.mode === 'seq' ? 'on' : ''}" data-action="opt" data-k="mode" data-v="seq">순서대로</button>
      <button class="chip ${o.mode === 'shuffle' ? 'on' : ''}" data-action="opt" data-k="mode" data-v="shuffle">🔀 섞어서</button>
      <button class="chip ${o.reverse ? 'on' : ''}" data-action="opt" data-k="reverse" data-v="${o.reverse ? 0 : 1}">↔ 뒷면부터</button>
    </div>
    <div class="chips" style="margin-bottom:10px">
      <button class="chip ${o.filter === 'all' ? 'on' : ''}" data-action="opt" data-k="filter" data-v="all">전체</button>
      <button class="chip ${o.filter === 'unknown' ? 'on' : ''}" data-action="opt" data-k="filter" data-v="unknown">아직 못 외운 것 (${cnt('unknown')})</button>
      <button class="chip ${o.filter === 'wrong' ? 'on' : ''}" data-action="opt" data-k="filter" data-v="wrong">모름 표시만 (${cnt('wrong')})</button>
      <button class="chip ${o.filter === 'star' ? 'on' : ''}" data-action="opt" data-k="filter" data-v="star">★ 별표만 (${cnt('star')})</button>
    </div>
    <div class="row"><span class="muted">범위</span>
      <input class="input num" type="number" inputmode="numeric" min="1" max="${total}" value="${o.from}" data-change="from"> <span class="muted">~</span>
      <input class="input num" type="number" inputmode="numeric" min="1" max="${total}" value="${o.to}" data-change="to"> <span class="muted">번</span>
      <button class="btn sm" data-action="range" data-from="1" data-to="${total}">전체</button>
    </div>
    ${chunks}
    <div class="row" style="margin-top:14px">
      ${canResume ? `<button class="btn primary grow" data-action="resume">▶ 이어하기 (${sess.i + 1}/${sess.ids.length})</button><button class="btn" data-action="start" ${n ? '' : 'disabled'}>처음부터</button>` : `<button class="btn primary grow" data-action="start" ${n ? '' : 'disabled'}>▶ 학습 시작 (${n}장)</button>`}
    </div>
  </div>`;
}
function addCardBox(deckId, folderId) {
  return `<div class="card-box">
    <h2>카드 추가${folderId ? ' <span class="muted" style="font-weight:400">· "직접 입력" 세트에 저장</span>' : ''}</h2>
    <form data-form="add-card" data-deck="${deckId || ''}" data-folder="${folderId || ''}">
      <input class="input" name="f" placeholder="앞면 (단어)" autocomplete="off" style="margin-bottom:8px">
      <textarea class="input" name="b" placeholder="뒷면 (뜻)" rows="2" style="min-height:60px;margin-bottom:8px"></textarea>
      <div class="row" style="margin-bottom:8px"><button class="btn sm" type="button" data-action="form-img" data-side="fi">📷 앞면 사진</button><button class="btn sm" type="button" data-action="form-img" data-side="bi">📷 뒷면 사진</button><span class="muted" id="form-img-info"></span></div>
      <div class="row"><button class="btn primary" type="submit">추가</button><button class="btn" type="button" data-action="import" data-deck="${deckId || ''}" data-folder="${folderId || ''}">📥 파일/텍스트로 대량 추가</button></div>
    </form>
  </div>`;
}
let formImgs = { fi: null, bi: null };

/* ---------- view: folder ---------- */
function viewFolder(id) {
  const f = folderById(id); if (!f) return viewHome();
  const scope = getScope('folder', id); const decks = folderDecks(id); const subs = childFolders(id); const depth = folderDepth(id); const parent = effParent(f);
  const crumbs = folderPath(id).slice(0, -1).map(x => `<a href="#/folder/${x.id}">📁 ${esc(x.name)}</a>`).join(' › ');
  const hasStudy = scope.deckIds.length > 0;
  return topbar(f.name, `<button class="iconbtn" data-action="go" data-to="${parent ? '#/folder/' + parent : '#/'}">‹</button>`, `${pill()}<button class="iconbtn" data-action="folder-menu" title="폴더 메뉴">⋮</button>`) +
    `<div class="page">${crumbs ? `<div class="muted" style="margin-bottom:8px">${crumbs}</div>` : ''}<div class="${hasStudy ? 'cols' : ''}">
      ${hasStudy ? `<div class="col-a">${studyPanel(scope)}</div>` : ''}
      <div class="col-b">
      ${depth < MAX_DEPTH || subs.length ? `<div class="card-box">
        <div class="row" style="margin-bottom:8px"><h2 style="margin:0" class="grow">하위 폴더 (${subs.length})</h2>${depth < MAX_DEPTH ? `<button class="btn sm" data-action="new-subfolder" data-folder="${id}">+ 하위 폴더</button>` : ''}</div>
        ${subs.map(folderRow).join('') || '<div class="muted">하위 폴더가 없습니다. 예: "산과" 폴더 안에 "산전진찰", "분만" 같은 단원 폴더를 만들 수 있습니다.</div>'}
      </div>` : ''}
      <div class="card-box">
        <div class="row" style="margin-bottom:8px"><h2 style="margin:0" class="grow">세트 (${decks.length})</h2><button class="btn sm" data-action="new-deck" data-folder="${id}">+ 빈 세트</button><button class="btn sm" data-action="import" data-folder="${id}">📥 파일 가져오기</button></div>
        ${decks.map((d, i) => deckRow(d, i)).join('') || '<div class="muted">세트가 없습니다. 아래에서 카드를 직접 추가하거나 엑셀 파일을 가져오면 세트가 만들어집니다.</div>'}
      </div>
      ${addCardBox(null, id)}
      </div>
    </div></div>`;
}

/* ---------- view: deck ---------- */
function viewDeck(id) {
  const d = deckById(id); if (!d) return viewHome();
  const scope = getScope('deck', id); const cards = liveCards(d); const f = d.folderId && folderById(d.folderId);
  const q = deckSearch.trim().toLowerCase();
  const shown = q ? cards.filter(c => c.f.toLowerCase().includes(q) || c.b.toLowerCase().includes(q)) : cards;
  const rows = shown.slice(0, listLimit).map(c => { const p = getP(id, c.id) || {}; const idx = cards.indexOf(c) + 1; return `<div class="cardrow">
      <div class="idx">${idx}</div>
      ${c.fi || c.bi ? `<div class="thumb imgwrap"><img class="hidden" data-img="${c.fi || c.bi}" alt=""></div>` : ''}
      <div class="txt" data-action="edit-card" data-id="${c.id}"><div class="f">${esc(c.f) || '<span class="muted">(사진)</span>'}${p.k === 1 ? '<span class="tag ok">알았음</span>' : p.k === 0 ? '<span class="tag no">모름</span>' : ''}</div><div class="b">${esc(c.b)}${c.bi ? ' 📷' : ''}</div></div>
      <div class="acts"><button class="star ${p.s ? 'on' : ''}" data-action="star" data-id="${c.id}" data-deck="${id}" title="별표">${p.s ? '★' : '☆'}</button><button data-action="edit-card" data-id="${c.id}" title="편집">⋯</button></div>
    </div>`; }).join('');
  return topbar(d.name, `<button class="iconbtn" data-action="go" data-to="${f ? '#/folder/' + f.id : '#/'}">‹</button>`, `${pill()}<button class="iconbtn" data-action="deck-menu" title="세트 메뉴">⋮</button>`) +
    `<div class="page">
      ${f ? `<div class="muted" style="margin-bottom:8px">📁 ${esc(f.name)}</div>` : ''}
      <div class="cols">
      <div class="col-a">${studyPanel(scope)}</div>
      <div class="col-b">
      ${addCardBox(id, null)}
      <div class="card-box">
        <div class="row" style="margin-bottom:8px"><h2 style="margin:0" class="grow">카드 목록 (${cards.length})</h2><input class="input" style="width:50%;min-height:38px" placeholder="검색" value="${esc(deckSearch)}" data-input="search"></div>
        ${rows || '<div class="muted">카드가 없습니다.</div>'}
        ${shown.length > listLimit ? `<div class="row" style="padding-top:10px;justify-content:center"><button class="btn sm" data-action="more">더 보기 (${shown.length - listLimit}장 남음)</button><button class="btn sm ghost" data-action="more-all">전부 펼치기</button></div>` : ''}
      </div>
      </div></div>
    </div>`;
}

/* ---------- study session ---------- */
function buildSession(scope, o, keys) {
  let items;
  if (keys) items = keys.map(k => { const [d, c] = splitKey(k); const dk = deckById(d); const card = dk && dk.cards[c]; return card && !card.deleted ? { d, c: card } : null; }).filter(Boolean);
  else items = filterItems(scopeCards(scope, o.inc).slice(o.from - 1, o.to), o);
  let ids = items.map(x => key(x.d, x.c.id)); const seed = newSeed();
  if (o.mode === 'shuffle') ids = shuffleSeeded(ids, seed);
  return { ids, i: 0, back: false, seed, mode: o.mode, reverse: !!o.reverse, res: {}, started: now() };
}
function startStudy(scope, keys) {
  const o = sessOpts(scope); const s = sessions[skey(scope)] || (sessions[skey(scope)] = {}); s.opts = o; s.cur = buildSession(scope, o, keys); saveSessions();
  go(`#/study/${scope.type}/${scope.id}`);
}
function faceHtml(label, text, img, cardId, deckId, starred, hint) {
  return `<div class="face ${img ? 'hasimg' : ''}" data-action="flip"><span class="label">${label}</span><button class="star ${starred ? 'on' : ''}" data-action="star" data-id="${cardId}" data-deck="${deckId}">${starred ? '★' : '☆'}</button>
    ${img ? `<div class="imgwrap big"><img class="hidden" data-img="${img}" alt="" data-action="zoom"></div>` : ''}
    ${text ? `<div class="content ${fontClass(text, !!img)}">${esc(text)}</div>` : ''}${hint ? '<span class="hint">탭하면 뒤집힘</span>' : ''}</div>`;
}
function viewStudy(type, id) {
  const scope = getScope(type, id); const s = scope && sessions[skey(scope)] && sessions[skey(scope)].cur;
  if (!scope) return viewHome(); if (!s) return type === 'deck' ? viewDeck(id) : viewFolder(id);
  const back = `#/${type}/${id}`; const total = s.ids.length;
  if (s.i >= total || total === 0) {
    const ok = Object.values(s.res).filter(v => v === 1).length, no = Object.values(s.res).filter(v => v === 0).length;
    const wrong = s.ids.filter(i => s.res[i] === 0);
    return `<div class="study">${topbar(scope.name, `<button class="iconbtn" data-action="go" data-to="${back}">‹</button>`)}
      <div class="stage"><div class="summary">
        <div style="font-size:40px">🎉</div><h3 style="margin:8px 0">학습 완료</h3>
        <div class="nums"><div class="ok"><b>${ok}</b>알았음</div><div class="no"><b>${no}</b>모름</div><div><b>${total - ok - no}</b>건너뜀</div></div>
        <div class="row" style="justify-content:center">
          ${wrong.length ? `<button class="btn no" data-action="restudy-wrong">모른 것만 다시 (${wrong.length})</button>` : ''}
          <button class="btn primary" data-action="start">처음부터 다시</button>
          <button class="btn" data-action="go" data-to="${back}">돌아가기</button>
        </div></div></div></div>`;
  }
  const [did, cid] = splitKey(s.ids[s.i]); const c = data.decks[did].cards[cid]; const p = getP(did, cid) || {};
  const fT = s.reverse ? c.b : c.f, bT = s.reverse ? c.f : c.b, fI = s.reverse ? c.bi : c.fi, bI = s.reverse ? c.fi : c.bi;
  const done = Object.keys(s.res).length; const dname = scope.type === 'folder' ? deckById(did).name : '';
  return `<div class="study">
    ${topbar(scope.name, `<button class="iconbtn" data-action="go" data-to="${back}" title="나가기">✕</button>`, `<button class="iconbtn" data-action="study-menu" title="옵션">⋮</button>`)}
    <div class="stage">
      <div class="progress"><span>${s.i + 1} / ${total}</span><div class="bar"><i style="width:${Math.round(s.i / total * 100)}%"></i></div><span>${s.mode === 'shuffle' ? '🔀 ' : ''}${done}장 평가</span></div>
      ${dname ? `<div class="muted" style="margin:-4px 0 8px;text-align:center">${esc(dname)}</div>` : ''}
      <div class="flip ${s.back ? 'back' : ''} ${settings.flipAnim ? '' : 'noanim'}" id="flip"><div class="inner">
        ${faceHtml(s.reverse ? '뒷면' : '앞면', fT, fI, cid, did, p.s, settings.showHint)}
        ${faceHtml(s.reverse ? '앞면' : '뒷면', bT, bI, cid, did, p.s, false).replace('class="face', 'class="face backface')}
      </div></div>
    </div>
    <div class="actions"><div class="row">
      <button class="btn nav" data-action="prev" ${s.i === 0 ? 'disabled' : ''}>‹</button>
      <button class="btn no" data-action="mark" data-v="0">모름</button>
      <button class="btn ok" data-action="mark" data-v="1">알았음</button>
      <button class="btn nav" data-action="next">›</button>
    </div></div>
  </div>`;
}

/* ---------- view: settings ---------- */
let showHelp = false;
function viewSettings() {
  const st = syncStatus(); const all = liveDecks(); const nc = all.reduce((a, d) => a + liveCards(d).length, 0); const ni = Object.keys(data.images).length;
  return topbar('설정', `<button class="iconbtn" data-action="go" data-to="#/">‹</button>`) +
    `<div class="page">
      <div class="card-box">
        <h2>구글 드라이브 동기화</h2>
        <div class="row" style="margin-bottom:10px">${pill()}<span class="muted" id="sync-detail">${esc(sync.msg || settings.sync.email || '')}</span></div>
        <div class="row" style="margin-bottom:10px">
          ${settings.signedIn ? `<button class="btn" data-action="sync-now">지금 동기화</button><button class="btn ghost" data-action="sign-out">로그아웃</button>` : `<button class="btn primary" data-action="sign-in" ${settings.clientId ? '' : 'disabled'}>Google 로그인</button>`}
          <button class="btn ghost sm" data-action="toggle-help">${showHelp ? '고급 설정 닫기' : '고급 설정'}</button>
        </div>
        ${showHelp ? `<label class="field"><span>Google OAuth 클라이언트 ID (기본값이 들어 있습니다)</span><input class="input" data-input="clientId" value="${esc(settings.clientId)}" placeholder="xxxx.apps.googleusercontent.com" autocomplete="off"></label>
        <div class="help">데이터는 내 드라이브의 <code>Amnesia/amnesia-decks.json</code>, 사진은 <code>Amnesia/images/</code>에 저장됩니다. 같은 계정으로 로그인한 모든 기기에서 자동으로 합쳐집니다. 다른 프로젝트를 쓰려면 Google Cloud Console에서 만든 웹 클라이언트 ID를 넣고, 승인된 JavaScript 원본에 <code>${esc(location.origin)}</code>을 추가하세요.</div>` : ''}
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
        <h2>학습 기록</h2>
        <div class="row"><button class="btn" data-action="reset-all">전체 학습 기록 초기화</button><button class="btn ghost" data-action="reset-all-stars">별표까지 모두 지우기</button></div>
        <div class="muted" style="margin-top:6px">폴더/세트 하나만 초기화하려면 해당 화면의 ⋮ 메뉴를 쓰세요.</div>
      </div>
      <div class="card-box">
        <h2>데이터</h2>
        <div class="row">
          <button class="btn" data-action="backup">전체 백업 (JSON)</button>
          <button class="btn" data-action="restore">백업 복원</button>
          <button class="btn ghost" data-action="wipe" style="color:var(--no)">전체 삭제</button>
        </div>
        <div class="muted" style="margin-top:8px">폴더 ${liveFolders().length}개 · 세트 ${all.length}개 · 카드 ${nc}장 · 사진 ${ni}장 · 텍스트 ${(JSON.stringify(data).length / 1024).toFixed(0)} KB</div>
        <div id="install-row" class="row" style="margin-top:10px">${isStandalone() ? '<span class="muted">📱 홈 화면 앱으로 실행 중입니다</span>' : '<button class="btn primary" data-action="install">📱 홈 화면에 앱 설치</button>'}</div>
      </div>
      <div class="muted" style="text-align:center">Amnesia 낱말카드 · 키보드: Space 뒤집기, ←/→ 이동, 1 모름, 2 알았음</div>
    </div>`;
}

/* ---------- modals ---------- */
function openModal(html) { $('#modal-root').innerHTML = `<div class="modal-bg" data-action="close-modal-bg"><div class="modal">${html}</div></div>`; hydrateImages($('#modal-root')); }
function closeModal() { $('#modal-root').innerHTML = ''; }
function confirmModal(title, body, okText, onOk, danger = false, extra = null) {
  openModal(`<h3>${esc(title)}</h3><div class="small" style="color:var(--muted)">${body}</div><div class="foot"><button class="btn" data-action="close-modal">취소</button>${extra ? `<button class="btn" id="modal-extra">${esc(extra.text)}</button>` : ''}<button class="btn ${danger ? 'no' : 'primary'}" id="modal-ok">${esc(okText)}</button></div>`);
  $('#modal-ok').onclick = () => { closeModal(); onOk(); };
  if (extra) $('#modal-extra').onclick = () => { closeModal(); extra.run(); };
}
function promptModal(title, value, okText, onOk, placeholder = '') {
  openModal(`<h3>${esc(title)}</h3><input class="input" id="modal-input" value="${esc(value)}" placeholder="${esc(placeholder)}"><div class="foot"><button class="btn" data-action="close-modal">취소</button><button class="btn primary" id="modal-ok">${esc(okText)}</button></div>`);
  const inp = $('#modal-input'); inp.focus(); inp.select();
  const ok = () => { closeModal(); onOk(inp.value); };
  $('#modal-ok').onclick = ok; inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
}
function chooseModal(title, options, onPick) {
  openModal(`<h3>${esc(title)}</h3>${options.map((o, i) => `<button class="btn block" style="justify-content:flex-start;margin-bottom:8px;${o.danger ? 'color:var(--no)' : ''}" data-pick="${i}">${o.label}</button>`).join('')}<div class="foot"><button class="btn" data-action="close-modal">취소</button></div>`);
  $('#modal-root').querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { closeModal(); onPick(options[+b.dataset.pick]); });
}
function imgField(side, imgId) { return `<div class="row" style="margin-bottom:10px"><div class="thumb imgwrap ${imgId ? '' : 'hidden'}" id="ec-${side}-wrap"><img class="hidden" ${imgId ? `data-img="${imgId}"` : ''} alt=""></div><button class="btn sm" type="button" data-action="ec-img" data-side="${side}">📷 ${imgId ? '사진 변경' : '사진 추가'}</button>${imgId ? `<button class="btn sm ghost" type="button" data-action="ec-img-del" data-side="${side}">사진 삭제</button>` : ''}</div>`; }
let ec = null;
function editCardModal(deckId, cardId) {
  const c = data.decks[deckId].cards[cardId]; ec = { deckId, cardId, fi: c.fi || null, bi: c.bi || null };
  renderEdit(c.f, c.b);
}
function renderEdit(f, b) {
  openModal(`<h3>카드 편집</h3>
    <label class="field"><span>앞면</span><textarea class="input" id="ec-f" rows="2">${esc(f)}</textarea></label>${imgField('fi', ec.fi)}
    <label class="field"><span>뒷면</span><textarea class="input" id="ec-b" rows="4">${esc(b)}</textarea></label>${imgField('bi', ec.bi)}
    <div class="row small" style="margin-bottom:6px"><button class="btn sm" id="ec-up">↑ 위로</button><button class="btn sm" id="ec-down">↓ 아래로</button><button class="btn sm" id="ec-reset">기록 지우기</button><span class="grow"></span><button class="btn sm" id="ec-del" style="color:var(--no)">삭제</button></div>
    <div class="foot"><button class="btn" data-action="close-modal">취소</button><button class="btn primary" id="modal-ok">저장</button></div>`);
  const { deckId, cardId } = ec;
  $('#modal-ok').onclick = () => { updateCard(deckId, cardId, { f: $('#ec-f').value, b: $('#ec-b').value, fi: ec.fi, bi: ec.bi }); closeModal(); render(); };
  $('#ec-up').onclick = () => { moveCard(deckId, cardId, -1); closeModal(); render(); };
  $('#ec-down').onclick = () => { moveCard(deckId, cardId, 1); closeModal(); render(); };
  $('#ec-reset').onclick = () => { setP(deckId, cardId, { k: null }); closeModal(); render(); };
  $('#ec-del').onclick = () => { deleteCard(deckId, cardId); closeModal(); render(); toast('삭제했습니다'); };
}

/* import wizard */
let imp = null;
function importModal(deckId, folderId) {
  imp = { deckId: deckId || null, folderId: folderId || null, step: 1, sheets: null, si: 0, header: null, colF: 0, colB: 1, colD: -1, target: deckId ? deckId : 'new', newName: '', skipDup: true, delim: 'auto', text: '', newFolderFor: null };
  renderImport();
}
function renderImport() {
  if (imp.step === 1) {
    openModal(`<h3>카드 가져오기</h3>
      <div class="help" style="margin-bottom:10px">엑셀(.xlsx) / CSV / 텍스트 파일을 선택하세요. 안드로이드에서는 파일 선택 창에서 <b>Google 드라이브</b>의 파일도 바로 고를 수 있습니다.</div>
      <input type="file" id="imp-file" accept=".xlsx,.xls,.xlsm,.csv,.txt,.tsv" class="input" style="padding:8px" multiple>
      <div class="muted" style="margin-top:4px">여러 파일을 한꺼번에 선택할 수 있습니다 (파일마다 세트 1개).</div>
      <div class="muted" style="margin:14px 0 6px">또는 직접 붙여넣기 (한 줄에 한 카드: <code>단어[Tab]뜻</code>, <code>단어 : 뜻</code>, <code>단어 - 뜻</code>)</div>
      <textarea class="input" id="imp-text" rows="6" placeholder="자궁내막염(endometritis) : clindamycin + gentamicin&#10;유방염(mastitis) : dicloxacillin">${esc(imp.text)}</textarea>
      <div class="row" style="margin-top:8px"><span class="muted">구분자</span><select class="input" id="imp-delim" style="width:auto;min-height:36px;padding:4px 8px"><option value="auto">자동</option><option value="tab">탭</option><option value="colon">콜론 :</option><option value="dash">하이픈 -</option><option value="comma">쉼표 ,</option></select></div>
      <div class="foot"><button class="btn" data-action="close-modal">취소</button><button class="btn primary" id="imp-next">다음</button></div>`);
    $('#imp-delim').value = imp.delim;
    $('#imp-file').onchange = async e => {
      const fl = [...e.target.files]; if (!fl.length) return;
      if (fl.length > 1) {
        try {
          toast(`파일 ${fl.length}개 읽는 중…`);
          imp.multi = [];
          for (const file of fl) {
            try { const r = await parseFile(file); const sheet = r.sheets.find(s => s.rows.length) || r.sheets[0]; imp.multi.push(Object.assign({ name: file.name.replace(/\.[^.]+$/, ''), rows: sheet.rows, sheets: r.sheets.filter(s => s.rows.length).length }, detectFor(sheet.rows))); }
            catch (err) { imp.multi.push({ name: file.name, error: err.message, rows: [] }); }
          }
          imp.split = true; imp.step = 'multi'; renderImport();
        } catch (err) { toast('읽기 실패: ' + err.message, 4000); }
        return;
      }
      const f = fl[0];
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
  if (imp.step === 'multi') return renderMultiImport();
  const sheet = imp.sheets[imp.si]; const rows = sheet.rows; const ncol = Math.max(...rows.slice(0, 50).map(r => r.length), 2);
  const body = rows.slice(imp.header ? 1 : 0);
  const colOpts = sel => Array.from({ length: ncol }, (_, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${String.fromCharCode(65 + (i % 26))}열${imp.header && rows[0][i] ? ' (' + esc(String(rows[0][i]).slice(0, 12)) + ')' : ''}</option>`).join('');
  const prev = rows.slice(0, 6).map(r => `<tr>${Array.from({ length: ncol }, (_, i) => `<td style="${i === imp.colF ? 'background:rgba(79,109,245,.15)' : i === imp.colB ? 'background:rgba(22,163,74,.12)' : i === imp.colD ? 'background:rgba(245,158,11,.15)' : ''}">${esc(String(r[i] ?? '').slice(0, 40))}</td>`).join('')}</tr>`).join('');
  const folders = liveFolders(); const decks = liveDecks(); const deckNames = imp.colD >= 0 ? new Set(body.map(r => String(r[imp.colD] ?? '').trim()).filter(Boolean)) : null;
  const folderOpts = `<option value="">(폴더 없음 · 최상위)</option>${folderOptions(imp.folderId)}`;
  openModal(`<h3>열 선택 · ${body.length}개 행</h3>
    ${imp.sheets.length > 1 ? `<label class="field"><span>시트</span><select class="input" id="imp-sheet">${imp.sheets.map((s, i) => `<option value="${i}" ${i === imp.si ? 'selected' : ''}>${esc(s.name)} (${s.rows.length})</option>`).join('')}</select></label>` : ''}
    <div class="scrollx" style="margin-bottom:10px"><table class="preview"><thead><tr>${Array.from({ length: ncol }, (_, i) => `<th>${String.fromCharCode(65 + (i % 26))}</th>`).join('')}</tr></thead><tbody>${prev}</tbody></table></div>
    <label class="switch"><span>첫 행은 제목 (건너뛰기)</span><input type="checkbox" id="imp-header" ${imp.header ? 'checked' : ''}></label>
    <div class="row"><label class="field grow"><span>앞면 열</span><select class="input" id="imp-f">${colOpts(imp.colF)}</select></label><label class="field grow"><span>뒷면 열</span><select class="input" id="imp-b">${colOpts(imp.colB)}</select></label></div>
    <label class="field"><span>세트 나누기 열 (선택: 이 열의 값마다 세트가 생깁니다, 예: 과목)</span><select class="input" id="imp-d"><option value="-1">사용 안 함</option>${colOpts(imp.colD)}</select></label>
    ${imp.colD >= 0 ? `<div class="muted" style="margin-bottom:8px">→ ${deckNames.size}개 세트: ${esc([...deckNames].slice(0, 8).join(', '))}${deckNames.size > 8 ? ' …' : ''}</div><label class="field"><span>세트들을 넣을 폴더</span><select class="input" id="imp-folder"><option value="__new__">새 폴더 "${esc(imp.newName)}"${imp.folderId && folderById(imp.folderId) ? ' (📁 ' + esc(folderById(imp.folderId).name) + ' 안에)' : ''}</option>${folderOpts}</select></label>` : `
    <label class="field"><span>저장할 세트</span><select class="input" id="imp-target"><option value="new" ${imp.target === 'new' ? 'selected' : ''}>새 세트 만들기</option>${decks.map(d => `<option value="${d.id}" ${imp.target === d.id ? 'selected' : ''}>${esc(d.name)}${d.folderId && folderById(d.folderId) ? ' (📁 ' + esc(folderById(d.folderId).name) + ')' : ''} · ${liveCards(d).length}장</option>`).join('')}</select></label>
    ${imp.target === 'new' ? `<label class="field"><span>새 세트 이름</span><input class="input" id="imp-name" value="${esc(imp.newName)}"></label><label class="field"><span>폴더</span><select class="input" id="imp-folder">${folderOpts}</select></label>` : ''}`}
    <label class="switch"><span>앞면이 같은 카드는 건너뛰기</span><input type="checkbox" id="imp-dup" ${imp.skipDup ? 'checked' : ''}></label>
    <div class="foot"><button class="btn" id="imp-back">이전</button><button class="btn primary" id="imp-go">가져오기</button></div>`);
  const readUi = () => { imp.colF = +$('#imp-f').value; imp.colB = +$('#imp-b').value; imp.colD = +$('#imp-d').value; imp.header = $('#imp-header').checked; imp.skipDup = $('#imp-dup').checked; const t = $('#imp-target'); if (t) imp.target = t.value; const nm = $('#imp-name'); if (nm) imp.newName = nm.value; const fo = $('#imp-folder'); if (fo) imp.folderSel = fo.value; };
  ['#imp-f', '#imp-b', '#imp-d', '#imp-header', '#imp-target'].forEach(s => { const el = $(s); if (el) el.onchange = () => { readUi(); renderImport(); }; });
  const sh = $('#imp-sheet'); if (sh) sh.onchange = () => { imp.si = +sh.value; detectCols(); renderImport(); };
  $('#imp-back').onclick = () => { imp.step = 1; renderImport(); };
  $('#imp-go').onclick = () => {
    readUi();
    const body2 = rows.slice(imp.header ? 1 : 0);
    const pairs = body2.map(r => [r[imp.colF], r[imp.colB], imp.colD >= 0 ? String(r[imp.colD] ?? '').trim() : null]).filter(p => String(p[0] ?? '').trim() || String(p[1] ?? '').trim());
    let total = 0, created = 0, dest = null;
    const fsel = $('#imp-folder') ? $('#imp-folder').value : (imp.folderId || '');
    if (imp.colD >= 0) {
      const fid = fsel === '__new__' ? createFolder(imp.newName || '가져온 폴더', imp.folderId || null) : (fsel || null);
      const groups = new Map(); for (const p of pairs) { const k = p[2] || '(미분류)'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push([p[0], p[1]]); }
      for (const [name, ps] of groups) { let d = liveDecks().find(x => x.name === name && (x.folderId || null) === fid); const id = d ? d.id : (created++, createDeck(name, fid)); total += addCards(id, ps, imp.skipDup); }
      dest = fid ? '#/folder/' + fid : '#/';
    } else {
      const id = imp.target === 'new' ? (created++, createDeck(imp.newName || '새 세트', fsel || null)) : imp.target;
      total += addCards(id, pairs.map(p => [p[0], p[1]]), imp.skipDup); dest = '#/deck/' + id;
    }
    const skipped = pairs.length - total;
    closeModal(); toast(`${total}장 가져옴${created ? ` · 세트 ${created}개 생성` : ''}${skipped > 0 ? ` · 중복 ${skipped}장 건너뜀` : ''}`, 3500);
    go(dest); render();
  };
}
function detectFor(rows) {
  if (!rows.length) return { header: false, colF: 0, colB: 1, colD: -1 };
  const header = detectHeader(rows[0]);
  const hdr = rows[0].map(c => String(c ?? '').trim().toLowerCase());
  const find = ws => header ? hdr.findIndex(h => ws.includes(h)) : -1;
  const f = find(['앞면', '앞', '단어', '용어', '질문', '질환', 'front', 'term', 'word', 'question']);
  const b = find(['뒷면', '뒤', '뜻', '정답', '답', '항생제', 'back', 'definition', 'meaning', 'answer']);
  const dcol = find(['세트', '과목', '분류', '카테고리', '단원', 'deck', 'category', 'subject']);
  const colF = f >= 0 ? f : 0, colB = b >= 0 ? b : (colF === 0 ? 1 : 0);
  return { header, colF, colB, colD: dcol >= 0 && dcol !== colF && dcol !== colB ? dcol : -1 };
}
function detectCols() { Object.assign(imp, detectFor(imp.sheets[imp.si].rows)); }

/* several files at once: one set per file (or one subfolder per file split by its 단원/세트 column) */
function renderMultiImport() {
  const files = imp.multi; const ok = files.filter(f => !f.error);
  const anySplit = ok.some(f => f.colD >= 0);
  const cnt = f => f.rows.slice(f.header ? 1 : 0).filter(r => String(r[f.colF] ?? '').trim() || String(r[f.colB] ?? '').trim()).length;
  const L = i => String.fromCharCode(65 + i);
  const list = files.map(f => f.error ? `<div class="cardrow"><div class="txt"><div class="f">${esc(f.name)}</div><div class="b" style="color:var(--no)">읽기 실패: ${esc(f.error)}</div></div></div>` :
    `<div class="cardrow"><div class="txt"><div class="f">📄 ${esc(f.name)}</div><div class="b">${cnt(f)}장 · 앞면 ${L(f.colF)}열 / 뒷면 ${L(f.colB)}열${f.header ? ' · 첫 행 제목' : ''}${f.colD >= 0 ? ` · 나누기: ${L(f.colD)}열 (${new Set(f.rows.slice(f.header ? 1 : 0).map(r => String(r[f.colD] ?? '').trim()).filter(Boolean)).size}개)` : ''}${f.sheets > 1 ? ' · 첫 시트만' : ''}</div></div></div>`).join('');
  const startFolder = imp.folderSel !== undefined ? imp.folderSel : (imp.folderId || '');
  openModal(`<h3>파일 ${files.length}개 가져오기</h3>
    <div class="card-box" style="max-height:38dvh;overflow:auto;padding:4px 12px">${list}</div>
    <label class="field"><span>넣을 폴더</span><select class="input" id="mi-folder"><option value="__new__">새 폴더 만들기</option><option value="" ${startFolder === '' ? 'selected' : ''}>(폴더 없음 · 최상위)</option>${folderOptions(startFolder || null)}</select></label>
    <label class="field hidden" id="mi-newname-wrap"><span>새 폴더 이름</span><input class="input" id="mi-newname" value="가져온 파일"></label>
    ${anySplit ? `<label class="switch"><span>단원/세트 열이 있는 파일은 하위 폴더로 만들고 값마다 세트로 나누기</span><input type="checkbox" id="mi-split" ${imp.split ? 'checked' : ''}></label>` : ''}
    <label class="switch"><span>앞면이 같은 카드는 건너뛰기</span><input type="checkbox" id="mi-dup" ${imp.skipDup ? 'checked' : ''}></label>
    <div class="help">파일 이름이 세트 이름이 됩니다. 같은 폴더에 같은 이름의 세트가 있으면 그 세트에 이어서 추가합니다.</div>
    <div class="foot"><button class="btn" id="imp-back">이전</button><button class="btn primary" id="mi-go" ${ok.length ? '' : 'disabled'}>${ok.length}개 파일 가져오기</button></div>`);
  const fs = $('#mi-folder'); const syncNew = () => $('#mi-newname-wrap').classList.toggle('hidden', fs.value !== '__new__'); fs.onchange = syncNew; syncNew();
  $('#imp-back').onclick = () => { imp.step = 1; imp.multi = null; renderImport(); };
  $('#mi-go').onclick = () => {
    imp.skipDup = $('#mi-dup').checked; const split = !!($('#mi-split') && $('#mi-split').checked);
    let target = fs.value; if (target === '__new__') target = createFolder($('#mi-newname').value || '가져온 파일', imp.folderId || null);
    const base = target || null;
    let total = 0, rowsAll = 0, decksMade = 0, foldersMade = 0;
    const ensureDeck = (name, fid) => { const d = liveDecks().find(x => x.name === name && (x.folderId || null) === fid); if (d) return d.id; decksMade++; return createDeck(name, fid); };
    for (const f of ok) {
      const body = f.rows.slice(f.header ? 1 : 0).map(r => [r[f.colF], r[f.colB], f.colD >= 0 ? String(r[f.colD] ?? '').trim() : '']).filter(p => String(p[0] ?? '').trim() || String(p[1] ?? '').trim());
      rowsAll += body.length;
      if (split && f.colD >= 0) {
        const groups = new Map(); for (const p of body) { const k = p[2] || '(미분류)'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push([p[0], p[1]]); }
        const canNest = !base || folderDepth(base) < MAX_DEPTH;
        let fid = base, prefix = '';
        if (canNest) { const ex = childFolders(base).find(x => x.name === f.name); fid = ex ? ex.id : (foldersMade++, createFolder(f.name, base)); }
        else prefix = f.name + ' · ';
        for (const [name, ps] of groups) total += addCards(ensureDeck(prefix + name, fid), ps, imp.skipDup);
      } else {
        total += addCards(ensureDeck(f.name, base), body.map(p => [p[0], p[1]]), imp.skipDup);
      }
    }
    const skipped = rowsAll - total;
    closeModal(); toast(`${ok.length}개 파일 · ${total}장 가져옴${foldersMade ? ` · 폴더 ${foldersMade}개` : ''}${decksMade ? ` · 세트 ${decksMade}개` : ''}${skipped > 0 ? ` · 중복 ${skipped}장 건너뜀` : ''}`, 4000);
    go(base ? '#/folder/' + base : '#/'); render();
  };
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
function curScope() { const r = route(); if (r.name === 'study') return getScope(r.a, r.b); if (r.name === 'deck') return getScope('deck', r.a); if (r.name === 'folder') return getScope('folder', r.a); return null; }
function moveDeckModal(deckId) {
  const d = deckById(deckId); const opts = [{ label: '(폴더 없음 · 최상위)', id: '' }];
  const walk = (pid, prefix) => { for (const f of childFolders(pid)) { opts.push({ label: prefix + '📁 ' + esc(f.name) + (f.id === d.folderId ? ' (현재 위치)' : ''), id: f.id }); if (folderDepth(f.id) < MAX_DEPTH) walk(f.id, prefix + '　└ '); } };
  walk(null, '');
  chooseModal('세트를 옮길 폴더', opts, o => { moveDeck(deckId, o.id || null); render(); toast('이동했습니다'); });
}
function moveFolderModal(folderId) {
  const f = folderById(folderId); const hasKids = childFolders(folderId).length > 0;
  const opts = [{ label: '(최상위)', id: '' }];
  if (!hasKids) for (const t of childFolders(null)) if (t.id !== folderId) opts.push({ label: '📁 ' + esc(t.name) + ' 안으로', id: t.id });
  chooseModal(hasKids ? '하위 폴더가 있는 폴더는 최상위에만 둘 수 있습니다' : '폴더를 옮길 위치', opts, o => { moveFolder(folderId, o.id || null); render(); toast('이동했습니다'); });
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action; const r = route(); const scope = curScope();
  switch (a) {
    case 'go': listLimit = 200; deckSearch = ''; go(el.dataset.to); break;
    case 'fab': chooseModal('추가', [{ label: '📁 새 폴더 (단원)', id: 'folder' }, { label: '🗂 새 세트', id: 'deck' }, { label: '📥 엑셀/텍스트 가져오기', id: 'import' }], o => { if (o.id === 'folder') promptModal('새 폴더 이름', '', '만들기', v => { const id = createFolder(v); go('#/folder/' + id); }, '예: 산과'); else if (o.id === 'deck') promptModal('새 세트 이름', '', '만들기', v => { const id = createDeck(v); go('#/deck/' + id); }); else importModal(null, null); }); break;
    case 'new-deck': promptModal('새 세트 이름', '', '만들기', v => { const id = createDeck(v, el.dataset.folder || null); go('#/deck/' + id); }); break;
    case 'new-subfolder': promptModal('하위 폴더 이름', '', '만들기', v => { const id = createFolder(v, el.dataset.folder); go('#/folder/' + id); }, '예: 산전진찰'); break;
    case 'import': importModal(el.dataset.deck || null, el.dataset.folder || null); break;
    case 'sync-pill': if (!settings.clientId) go('#/settings'); else if (!settings.signedIn || sync.needLogin) signIn(); else runSync(true); break;
    case 'sign-in': signIn(); break;
    case 'sign-out': signOut(); break;
    case 'sync-now': if (sync.needLogin || !tokenValid()) signIn(); else runSync(true); break;
    case 'toggle-help': showHelp = !showHelp; render(); break;
    case 'close-modal': closeModal(); break;
    case 'close-modal-bg': if (e.target === el) closeModal(); break;
    case 'more': listLimit += 300; render(); break;
    case 'more-all': listLimit = 1e9; render(); break;
    case 'opt': { const o = sessOpts(scope); const k = el.dataset.k; o[k] = k === 'reverse' ? el.dataset.v === '1' : el.dataset.v; (sessions[skey(scope)] ||= {}).opts = o; saveSessions(); render(); break; }
    case 'range': { const o = sessOpts(scope); o.from = +el.dataset.from; o.to = +el.dataset.to; o.toAll = o.from === 1 && o.to === scopeCards(scope, o.inc).length; (sessions[skey(scope)] ||= {}).opts = o; saveSessions(); render(); break; }
    case 'inc': { const o = sessOpts(scope); let inc = o.inc ? o.inc.slice() : scope.deckIds.slice(); const id = el.dataset.id; inc = inc.includes(id) ? inc.filter(x => x !== id) : inc.concat(id); if (!inc.length) return toast('최소 한 세트는 포함해야 합니다'); o.inc = inc.length === scope.deckIds.length ? null : inc; o.toAll = true; (sessions[skey(scope)] ||= {}).opts = o; saveSessions(); render(); break; }
    case 'inc-all': { const o = sessOpts(scope); o.inc = null; o.toAll = true; (sessions[skey(scope)] ||= {}).opts = o; saveSessions(); render(); break; }
    case 'start': startStudy(scope); break;
    case 'resume': go(`#/study/${scope.type}/${scope.id}`); break;
    case 'restudy-wrong': { const s = sessions[skey(scope)].cur; const wrong = s.ids.filter(i => s.res[i] === 0); sessions[skey(scope)].cur = buildSession(scope, sessions[skey(scope)].opts, wrong); saveSessions(); render(); break; }
    case 'flip': { const s = sessions[skey(scope)].cur; s.back = !s.back; $('#flip').classList.toggle('back', s.back); saveSessions(); break; }
    case 'zoom': { e.stopPropagation(); const src = el.src; if (src) openModal(`<img src="${src}" style="width:100%;border-radius:12px" alt=""><div class="foot"><button class="btn" data-action="close-modal">닫기</button></div>`); break; }
    case 'star': { e.stopPropagation(); const cid = el.dataset.id, did = el.dataset.deck; const p = getP(did, cid) || {}; setP(did, cid, { s: p.s ? 0 : 1 }); if (r.name === 'study') document.querySelectorAll('.face .star').forEach(b => { b.classList.toggle('on', !p.s); b.textContent = !p.s ? '★' : '☆'; }); else render(); break; }
    case 'mark': { const s = sessions[skey(scope)].cur; const [did, cid] = splitKey(s.ids[s.i]); const v = +el.dataset.v; s.res[s.ids[s.i]] = v; setP(did, cid, { k: v }); s.i++; s.back = false; saveSessions(); render(); break; }
    case 'next': { const s = sessions[skey(scope)].cur; s.i++; s.back = false; saveSessions(); render(); break; }
    case 'prev': { const s = sessions[skey(scope)].cur; if (s.i > 0) { s.i--; s.back = false; saveSessions(); render(); } break; }
    case 'study-menu': { e.stopPropagation(); const s = sessions[skey(scope)].cur; openMenu([
      { id: 'flipdir', label: `↔ ${s.reverse ? '앞면부터 보기' : '뒷면부터 보기'}`, run: () => { s.reverse = !s.reverse; s.back = false; saveSessions(); render(); } },
      { id: 'reshuffle', label: '🔀 다시 섞기 (새 랜덤 시드)', run: () => { const rest = s.ids.slice(s.i); const seed = newSeed(); s.ids = s.ids.slice(0, s.i).concat(shuffleSeeded(rest, seed)); s.seed = seed; s.mode = 'shuffle'; s.back = false; saveSessions(); render(); toast('남은 카드를 다시 섞었습니다 (seed ' + seed + ')'); } },
      { id: 'seed', label: `🎲 현재 시드: ${s.seed}`, run: () => promptModal('랜덤 시드 (같은 시드 = 같은 순서)', String(s.seed), '적용', v => { const seed = (parseInt(v, 10) >>> 0) || newSeed(); const base = buildSession(scope, Object.assign({}, sessions[skey(scope)].opts, { mode: 'seq' })); s.ids = shuffleSeeded(base.ids, seed); s.seed = seed; s.i = 0; s.back = false; s.res = {}; s.mode = 'shuffle'; saveSessions(); render(); }) },
      { id: 'edit', label: '✏️ 이 카드 편집', run: () => { const [did, cid] = splitKey(s.ids[s.i]); editCardModal(did, cid); } },
      { id: 'restart', label: '⟲ 처음부터', run: () => startStudy(scope) },
    ]); break; }
    case 'folder-menu': { e.stopPropagation(); const f = folderById(scope.id); openMenu([
      { id: 'rename', label: '✏️ 이름 바꾸기', run: () => promptModal('폴더 이름', f.name, '저장', v => { renameFolder(f.id, v); render(); }) },
      { id: 'move', label: '📁 다른 폴더로 이동', run: () => moveFolderModal(f.id) },
      { id: 'export', label: '📤 엑셀로 내보내기 (세트별 시트)', run: () => exportXlsx(f.name, scope.deckIds).catch(err => toast(err.message)) },
      { id: 'reset', label: '⟲ 이 폴더 학습 기록 초기화', run: () => confirmModal('학습 기록 초기화', `"${esc(f.name)}" 폴더의 모든 세트에서 알았음/모름 표시를 지웁니다. 별표는 유지됩니다.`, '초기화', () => { resetProgress(scope.deckIds); render(); toast('초기화했습니다'); }) },
      { id: 'delete', label: '🗑 폴더 삭제', danger: true, run: () => confirmModal('폴더 삭제', `"${esc(f.name)}" 폴더를 삭제합니다. 안의 ${childFolders(f.id).length ? `하위 폴더 ${childFolders(f.id).length}개와 ` : ''}세트 ${scope.deckIds.length}개를 함께 지울지, 최상위로 옮겨 남길지 선택하세요.`, '모두 삭제', () => { const back = effParent(f) ? '#/folder/' + effParent(f) : '#/'; deleteFolder(f.id, true); go(back); }, true, { text: '내용은 남기기', run: () => { const back = effParent(f) ? '#/folder/' + effParent(f) : '#/'; deleteFolder(f.id, false); go(back); } }) },
    ]); break; }
    case 'deck-menu': { e.stopPropagation(); const d = deckById(scope.id); openMenu([
      { id: 'rename', label: '✏️ 이름 바꾸기', run: () => promptModal('세트 이름', d.name, '저장', v => { renameDeck(d.id, v); render(); }) },
      { id: 'move', label: '📁 다른 폴더로 이동', run: () => moveDeckModal(d.id) },
      { id: 'export', label: '📤 엑셀로 내보내기', run: () => exportXlsx(d.name, [d.id]).catch(err => toast(err.message)) },
      { id: 'reset', label: '⟲ 학습 기록 초기화', run: () => confirmModal('학습 기록 초기화', '알았음/모름 표시와 진행 중인 학습이 지워집니다. 별표는 유지됩니다.', '초기화', () => { resetProgress([d.id]); render(); toast('초기화했습니다'); }) },
      { id: 'delete', label: '🗑 세트 삭제', danger: true, run: () => confirmModal('세트 삭제', `"${esc(d.name)}" 세트와 카드 ${liveCards(d).length}장을 삭제합니다.`, '삭제', () => { const back = d.folderId ? '#/folder/' + d.folderId : '#/'; deleteDeck(d.id); go(back); }, true) },
    ]); break; }
    case 'edit-card': editCardModal(scope.id, el.dataset.id); break;
    case 'ec-img': { const id = await pickImage(); if (id) { ec[el.dataset.side] = id; renderEdit($('#ec-f').value, $('#ec-b').value); } break; }
    case 'ec-img-del': { ec[el.dataset.side] = null; renderEdit($('#ec-f').value, $('#ec-b').value); break; }
    case 'form-img': { const id = await pickImage(); if (id) { formImgs[el.dataset.side] = id; const info = $('#form-img-info'); if (info) info.textContent = `${formImgs.fi ? '앞면 사진 ✓ ' : ''}${formImgs.bi ? '뒷면 사진 ✓' : ''}`; el.classList.add('primary'); } break; }
    case 'reset-all': confirmModal('전체 학습 기록 초기화', '모든 폴더와 세트의 알았음/모름 표시를 지웁니다. 별표는 유지됩니다.', '초기화', () => { resetProgress(liveDecks().map(d => d.id)); render(); toast('초기화했습니다'); }); break;
    case 'reset-all-stars': confirmModal('기록과 별표 모두 지우기', '알았음/모름 표시와 별표를 모두 지웁니다.', '모두 지우기', () => { resetProgress(liveDecks().map(d => d.id), false); render(); toast('초기화했습니다'); }, true); break;
    case 'backup': download(`amnesia-backup-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' })); break;
    case 'restore': { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json'; inp.onchange = async () => { try { const j = JSON.parse(await inp.files[0].text()); if (!j.decks) throw new Error('형식 오류'); j.folders ||= {}; j.progress ||= {}; j.images ||= {}; data = mergeData(data, j); saveData(); render(); toast('복원 완료 (기존 데이터와 병합)'); } catch (err) { toast('복원 실패: ' + err.message); } }; inp.click(); break; }
    case 'wipe': confirmModal('전체 삭제', '이 기기의 모든 폴더·세트·카드를 삭제합니다. 드라이브 동기화가 켜져 있으면 삭제도 동기화됩니다.', '모두 삭제', () => { for (const d of Object.values(data.decks)) { d.deleted = true; d.updated = now(); } for (const f of Object.values(data.folders)) { f.deleted = true; f.updated = now(); } sessions = {}; saveSessions(); saveData(); render(); }, true); break;
    case 'install': {
      if (installPrompt) { const p = installPrompt; installPrompt = null; p.prompt(); p.userChoice.then(r => { if (r.outcome === 'accepted') toast('설치되었습니다. 홈 화면에서 실행하세요'); else render(); }); break; }
      const ios = /iPhone|iPad/.test(navigator.userAgent);
      openModal(`<h3>홈 화면에 설치</h3><div class="help">
        <p>브라우저가 바로 설치 창을 띄워주지 않을 때는 메뉴에서 직접 추가하면 됩니다.</p>
        ${ios ? '<p><b>iPhone Safari</b>: 아래 공유 버튼(□↑) → <b>홈 화면에 추가</b></p>' : '<p><b>안드로이드 크롬</b>: 오른쪽 위 메뉴(⋮) → <b>홈 화면에 추가</b> 또는 <b>앱 설치</b></p><p><b>삼성 인터넷</b>: 아래 메뉴(≡) → <b>현재 페이지 추가</b> → <b>홈 화면</b></p>'}
        <p>이미 설치했다면 메뉴에 "앱 열기"가 보이거나 설치 항목이 사라집니다. 그 경우 홈 화면의 Amnesia 아이콘으로 실행하세요.</p>
      </div><div class="foot"><button class="btn primary" data-action="close-modal">확인</button></div>`);
      break;
    }
  }
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]'); if (!el) return;
  const k = el.dataset.change; const scope = curScope();
  if (k === 'from' || k === 'to') { const o = sessOpts(scope); o[k] = +el.value || 1; if (o.to < o.from) o.to = o.from; o.toAll = false; (sessions[skey(scope)] ||= {}).opts = o; saveSessions(); render(); return; }
  if (k === 'chunk') { (sessions[skey(scope)] ||= {}).chunk = +el.value; saveSessions(); render(); return; }
  if (k === 'theme') { settings.theme = el.value; applyTheme(); saveSettings(); return; }
  if (['autoSync', 'flipAnim', 'swipe', 'showHint'].includes(k)) { settings[k] = el.checked; saveSettings(); if (k === 'autoSync' && el.checked) scheduleSync(); }
});
document.addEventListener('input', e => {
  const el = e.target.closest('[data-input]'); if (!el) return;
  if (el.dataset.input === 'clientId') { settings.clientId = el.value.trim(); saveSettings(); const b = document.querySelector('[data-action="sign-in"]'); if (b) b.disabled = !settings.clientId; setStatus('idle'); }
  if (el.dataset.input === 'search') { deckSearch = el.value; clearTimeout(window._st); window._st = setTimeout(() => { const pos = el.selectionStart; render(); const n = document.querySelector('[data-input="search"]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }, 200); }
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-form="add-card"]'); if (!f) return; e.preventDefault();
  const fv = f.f.value, bv = f.b.value; if (!fv.trim() && !bv.trim() && !formImgs.fi && !formImgs.bi) return;
  let deckId = f.dataset.deck;
  if (!deckId) { const fid = f.dataset.folder; let d = folderDecks(fid).find(x => x.name === '직접 입력'); deckId = d ? d.id : createDeck('직접 입력', fid); }
  addCards(deckId, [{ f: fv, b: bv, fi: formImgs.fi, bi: formImgs.bi }]); formImgs = { fi: null, bi: null }; f.reset(); render();
  const n = document.querySelector('[data-form="add-card"] [name=f]'); if (n) n.focus(); toast(`${liveCards(data.decks[deckId]).length}번으로 추가됨`);
});
document.addEventListener('keydown', e => {
  if (route().name !== 'study' || $('#modal-root').innerHTML) return;
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  const map = { ' ': 'flip', 'Enter': 'flip', 'ArrowLeft': 'prev', 'ArrowRight': 'next', '1': 'mark0', '2': 'mark1', 'ArrowUp': 'flip', 'ArrowDown': 'flip' };
  const a = map[e.key]; if (!a) return; e.preventDefault();
  const sel = a.startsWith('mark') ? `[data-action="mark"][data-v="${a.slice(4)}"]` : `[data-action="${a}"]`;
  const b = document.querySelector(sel); if (b && !b.disabled) b.click();
});
function afterRender(r) {
  closeMenu();
  if (r.name === 'study' && settings.swipe) {
    const flip = $('#flip'); if (!flip) return; let sx = 0, sy = 0, t0 = 0;
    flip.addEventListener('touchstart', e => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; t0 = now(); }, { passive: true });
    flip.addEventListener('touchend', e => { const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy; if (Math.abs(dx) > 70 && Math.abs(dy) < 60 && now() - t0 < 600) { const b = document.querySelector(`[data-action="${dx < 0 ? 'next' : 'prev'}"]`); if (b && !b.disabled) b.click(); } }, { passive: true });
  }
}

/* ---------- boot ---------- */
let installPrompt = null;
function isStandalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('앱이 설치되었습니다'); if (route().name === 'settings') render(); });
function applyTheme() { if (settings.theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', settings.theme); }
const authRet = handleAuthReturn();
if (!(authRet && authRet.iframe)) {
  applyTheme();
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => { });
  try { if (isStandalone() && screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && settings.autoSync) runSync(false); });
  if (authRet && authRet.ok) afterLogin();
  else if (settings.clientId && settings.signedIn) {
    // keep the session alive without any popup: hidden-iframe refresh first, one silent redirect as fallback
    setTimeout(async () => {
      if (tokenValid()) { if (settings.autoSync) runSync(false); return; }
      try { await getToken(false); if (settings.autoSync) runSync(false); }
      catch (e) {
        const k = 'amnesia.silentRedirect'; const last = +sessionStorage.getItem(k) || 0;
        // fallback: one top-level round trip. With login_hint and an active Google session this bounces straight back;
        // if Google needs a one-time consent it shows it once (no account chooser) instead of failing silently.
        if (now() - last > 60000) { sessionStorage.setItem(k, String(now())); location.href = authUrl({ silent: !settings.sync.email }); }
        else { sync.needLogin = true; setStatus('error', '다시 로그인이 필요합니다'); }
      }
    }, 300);
  }
}
