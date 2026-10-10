'use strict';

// Runs in the PUBLIC status repo (thienhaicmu/meta-game-status) as a GitHub Action every 15 minutes — deployed there by
// tools/deploy-status-repo.mjs next to a copy of platform/portal/domain-resolver.cjs. For every portal in
// portals.json: follow its published page + anchors, keep only a page with the portal's label AND the game's
// fingerprint, and write the live url back. Writes the file only when something changed (a new url, a new failure, or
// once a day as a heartbeat — scheduled workflows of a repo with no activity are paused by GitHub after 60 days).
// A failure never removes the last good url: customers' apps keep it and try the anchors themselves.
//   node resolve-portals.cjs portals.json      (sets the step output `message` when the file changed)

const fs = require('node:fs');
const { resolvePortal } = require('./domain-resolver.cjs');

const HEARTBEAT_MS = 24 * 60 * 60 * 1000;

async function main() {
  const file = process.argv[2] || 'portals.json';
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = new Date();
  const notes = [];
  for (const [id, p] of Object.entries(doc.portals || {})) {
    if (!p.label || !p.fingerprint || !Array.isArray(p.anchors)) continue;
    const r = await resolvePortal(p, { fetchImpl: fetch, global: { url: p.url } });
    if (r.ok) {
      const stale = !p.checkedAt || now - Date.parse(p.checkedAt) > HEARTBEAT_MS;
      if (r.url !== p.url || stale || p.lastError) {
        notes.push(r.url !== p.url ? `${id} → ${r.url}` : `${id} ok`);
        Object.assign(p, { url: r.url, via: r.via, checkedAt: now.toISOString() });
        delete p.lastError; delete p.lastErrorAt;
      }
      console.log(`${id}: ${r.url} (via ${r.via})`);
    } else {
      const reason = r.tried.map((t) => `${t.url} ${t.reason}`).join('; ').slice(0, 400);
      if (p.lastError !== reason) { p.lastError = reason; p.lastErrorAt = now.toISOString(); notes.push(`${id} FAILED`); }
      console.log(`::warning::${id}: no live game page — ${reason}`);
    }
  }
  if (!notes.length) { console.log('no change'); return; }
  doc.updatedAt = now.toISOString();
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `message=portals: ${notes.join(' · ')}\n`);
  console.log(`changed: ${notes.join(' · ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
