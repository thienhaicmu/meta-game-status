'use strict';

// PORTAL DOMAIN RESOLVER — finds the LIVE game page of a portal whose domain keeps moving, and only ever accepts the
// real game. Game-neutral: a portal is { id, label, anchors[], fingerprint: { html[] } } (a game's manifest.portals).
//
// Candidates, in order (first that passes wins):
//   1. the GLOBAL entry (portals.json in the public status repo — the key tool / the GitHub Action keep it current)
//   2. the last page that passed on this machine
//   3. extra URLs (a page a logged-in profile is on; a link someone pasted)
//   4. the portal's ANCHORS (old domains that redirect to the live one) — the global file may add more
// A candidate passes when, after following its redirects: https, the final host carries the portal's LABEL as a whole
// label (play.hitclub.guitars ✓ · hitclub-vn.com ✗), and the page's HTML matches EVERY fingerprint pattern (the real
// game client; the marketing page and look-alike phishing pages fail).
//
// SELF-CONTAINED on purpose (node built-ins only): the same file runs in the status repo's GitHub Action
// (tools/deploy-status-repo.mjs copies it there).
//   checkUrl(url, portal, { fetchImpl })              → { ok, url (live origin), final, reason }
//   resolvePortal(portal, { fetchImpl, global, lastGood, extra }) → { ok, url, via, tried[] }
//   createPortalResolver({ fetchImpl, portalsUrl, cacheFile, log })  → resolve · current · status · learn

const fs = require('node:fs');
const path = require('node:path');

const TIMEOUT_MS = 12000;
const MAX_HTML_CHARS = 512 * 1024;
const MIN_INTERVAL_MS = 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function originOf(url) {
  try { const u = new URL(url); return u.protocol === 'https:' ? `${u.origin}/` : null; } catch { return null; }
}
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
const hasLabel = (host, label) => !!host && !!label && host.split('.').includes(String(label).toLowerCase());

function fingerprintMatches(html, fingerprint) {
  const res = (fingerprint && fingerprint.html) || [];
  return res.length > 0 && res.every((re) => new RegExp(re, 'i').test(html));
}

function candidateList(portal, { global = {}, lastGood = null, extra = [] } = {}) {
  const list = [global.url, lastGood && lastGood.url, ...extra, ...(global.anchors || []), ...(portal.anchors || [])];
  const seen = new Set();
  const out = [];
  for (const u of list) {
    if (typeof u !== 'string' || !/^https:\/\//i.test(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

async function checkUrl(url, portal, { fetchImpl, timeoutMs = TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'text/html' } });
    const final = res.url || url;
    if (!res.ok) return { ok: false, final, reason: `HTTP_${res.status}` };
    const origin = originOf(final);
    if (!origin) return { ok: false, final, reason: 'NOT_HTTPS' };
    if (!hasLabel(hostOf(final), portal.label)) return { ok: false, final, reason: 'WRONG_LABEL' };
    const html = String(await res.text()).slice(0, MAX_HTML_CHARS);
    if (!fingerprintMatches(html, portal.fingerprint)) return { ok: false, final, reason: 'NOT_THE_GAME' };
    return { ok: true, url: origin, final };
  } catch (e) {
    return { ok: false, final: url, reason: e && e.name === 'AbortError' ? 'TIMEOUT' : `NETWORK: ${(e && e.message) || e}` };
  } finally {
    clearTimeout(timer);
  }
}

async function resolvePortal(portal, { fetchImpl, global, lastGood, extra, timeoutMs } = {}) {
  const tried = [];
  for (const candidate of candidateList(portal, { global, lastGood, extra })) {
    const r = await checkUrl(candidate, portal, { fetchImpl, timeoutMs });
    tried.push({ url: candidate, ok: r.ok, final: r.final, reason: r.reason || null });
    if (r.ok) return { ok: true, url: r.url, via: candidate, tried };
  }
  return { ok: false, url: null, via: null, tried };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The app's side: one per game process. cacheFile keeps the last live page per portal; portalsUrl is the global file.
function createPortalResolver({ fetchImpl, portalsUrl = '', cacheFile, log = null, now = () => Date.now(), minIntervalMs = MIN_INTERVAL_MS }) {
  const cache = (cacheFile && readJson(cacheFile)) || { portals: {} };
  if (!cache.portals || typeof cache.portals !== 'object') cache.portals = {};
  const states = new Map();   // portal id → { state: 'checking'|'ok'|'failed', url, via, at, error }
  const inflight = new Map(); // portal id → Promise
  const lastTry = new Map();  // portal id → ms

  function save() {
    if (!cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(cache, null, 1), 'utf8');
      fs.renameSync(`${cacheFile}.tmp`, cacheFile);
    } catch (e) { if (log) log.warn('PORTAL_CACHE_WRITE_FAILED', { message: e.message }); }
  }

  async function fetchGlobal() {
    if (!portalsUrl) return {};
    const u = new URL(portalsUrl);
    u.searchParams.set('t', String(Math.floor(now() / 60000))); // past the raw CDN cache, once a minute
    try {
      const res = await fetchImpl(u.toString(), { cache: 'no-store' });
      if (!res.ok) return {};
      const body = await res.json();
      return (body && body.portals && typeof body.portals === 'object') ? body.portals : {};
    } catch { return {}; }
  }

  function remember(portal, url, via) {
    const prev = cache.portals[portal.id];
    cache.portals[portal.id] = { url, via, at: new Date(now()).toISOString() };
    save();
    if (log && (!prev || prev.url !== url)) log.event('PORTAL_RESOLVED', { portal: portal.id, url, via, previous: prev ? prev.url : null });
  }

  function resolve(portal, { force = false, extra = [] } = {}) {
    if (inflight.has(portal.id)) return inflight.get(portal.id);
    const st = states.get(portal.id);
    if (!force && st && st.state !== 'checking' && now() - (lastTry.get(portal.id) || 0) < minIntervalMs) return Promise.resolve(status(portal.id));
    lastTry.set(portal.id, now());
    states.set(portal.id, { ...(st || {}), state: 'checking', url: current(portal.id) });
    const job = (async () => {
      const global = (await fetchGlobal())[portal.id] || {};
      const r = await resolvePortal(portal, { fetchImpl, global, lastGood: cache.portals[portal.id], extra });
      if (r.ok) {
        remember(portal, r.url, r.via);
        states.set(portal.id, { state: 'ok', url: r.url, via: r.via, at: new Date(now()).toISOString(), error: null });
      } else {
        const stale = cache.portals[portal.id] ? cache.portals[portal.id].url : null;
        states.set(portal.id, { state: 'failed', url: stale, via: null, at: new Date(now()).toISOString(), error: 'Không tìm thấy trang game đang chạy của cổng này.' });
        if (log) log.warn('PORTAL_UNRESOLVED', { portal: portal.id, tried: r.tried.map((x) => `${x.url} ${x.reason || 'ok'}`) });
      }
      return status(portal.id);
    })().finally(() => inflight.delete(portal.id));
    inflight.set(portal.id, job);
    return job;
  }

  function current(id) {
    const st = states.get(id);
    if (st && st.url) return st.url;
    return cache.portals[id] ? cache.portals[id].url : null;
  }
  function status(id) {
    const st = states.get(id) || { state: cache.portals[id] ? 'cached' : 'unknown', url: current(id), via: cache.portals[id] ? cache.portals[id].via : null, at: cache.portals[id] ? cache.portals[id].at : null, error: null };
    return { id, ...st };
  }

  // a page a profile is on (logged in): if it carries the label and is not the known live page, prove it and use it
  async function learn(portal, url) {
    const origin = originOf(url);
    if (!origin || origin === current(portal.id) || !hasLabel(hostOf(origin), portal.label)) return false;
    const r = await checkUrl(origin, portal, { fetchImpl });
    if (!r.ok) return false;
    remember(portal, r.url, 'learned');
    states.set(portal.id, { state: 'ok', url: r.url, via: 'learned', at: new Date(now()).toISOString(), error: null });
    return true;
  }

  return { resolve, current, status, learn };
}

module.exports = { checkUrl, resolvePortal, candidateList, createPortalResolver, hasLabel, fingerprintMatches, originOf };
