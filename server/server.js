/**
 * Steam Tags Explorer HTTP server — the local transport.
 *
 * There is one catalog and one way to run this: `public/data/catalog.bin.gz`, the
 * ~6 MB file the GitHub Page serves. The same engine answers here and in a
 * visitor's browser, because the counting, the search and the payload shaping all
 * live in `engine.js`. This file is two things: a router that turns a URL into an
 * engine call, and the static file service for `public/`.
 *
 * Saved combinations belong to the browser that made them (`public/js/local-api.js`),
 * and the catalog is refreshed by `npm run update-snapshot`, which rewrites the
 * same file in place. Neither needs a server route.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { store } from '../public/engine/store.js';
import {
  configureEngine,
  bandGaps,
  handlers,
} from '../public/engine/engine.js';
import { loadCatalogSnapshot } from '../public/js/browser-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(ROOT, 'public');
const SNAPSHOT_PATH = path.join(PUBLIC_DIR, 'data', 'catalog.bin.gz');

let indexMs = 0;

/* --------------------------------- helpers --------------------------------- */

// `send` takes an object (always JSON), a string, or a Buffer (a static file body).
function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string' || Buffer.isBuffer(body);
  const payload = isText ? body : JSON.stringify(body);
  const contentType = isText
    ? headers['Content-Type'] || 'text/plain; charset=utf-8'
    : 'application/json; charset=utf-8';
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const sendJson = (res, body, status = 200) => send(res, status, body);
const sendError = (res, message, status = 400) => sendJson(res, { error: message }, status);

/* ---------------------------------- routes ---------------------------------- */

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

// Read-only API: one shared handler list, so the hosted page and this server
// cannot drift — there is exactly one body-building code path.
for (const { pattern, handler } of handlers) {
  route('GET', pattern, (req, res, params) => {
    const out = handler(params);
    if (out.status !== 200) return sendError(res, out.body.error, out.status);
    sendJson(res, out.body);
  });
}

/* --------------------------------- static --------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.bin': 'application/octet-stream',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendError(res, 'not found', 404);
  }
  let body;
  try {
    if (!fs.statSync(target).isFile()) throw new Error('not a file');
    body = fs.readFileSync(target);
  } catch {
    return sendError(res, 'not found', 404);
  }
  const ext = path.extname(target).toLowerCase();
  send(res, 200, body, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
  });
}

/* ---------------------------------- server ---------------------------------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (url.pathname.startsWith('/api/') && ms >= 100) console.log(`[api] ${req.method} ${url.pathname} ${ms}ms`);
  });

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = url.pathname.match(r.pattern);
    if (!match) continue;
    // A route that throws on its own must not take the server down with it.
    Promise.resolve()
      .then(() => r.handler(req, res, url.searchParams, match))
      .catch((err) => {
        console.error(`[api] ${req.method} ${url.pathname} failed: ${err.stack || err.message}`);
        if (!res.headersSent) sendError(res, 'internal error', 500);
      });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, url.pathname);
    return;
  }
  sendError(res, 'not found', 404);
});

/** The two boot notes every index deserves. */
function notePartialCatalog() {
  if (store.nGames >= 5000) return;
  console.log(
    `[index] note: only ${store.nGames} games are catalogued, so counts and rarity bands are`,
    'measured against that partial catalog. `npm run update-snapshot` fetches what Steam says is new.',
  );
}

// The bands a mix of that length cannot land in. Saying it as a gap is what makes the
// line readable: `4 tags: every band` means nothing is missing at that length.
function logBandGaps() {
  const gaps = Object.entries(bandGaps()).map(([n, missing]) => `${n} tags: ${missing.length ? `no ${missing.join(', ')} mix` : 'every band'}`);
  console.log(`[index] band coverage by length - ${gaps.join(' | ')}`);
}

function listen() {
  server.listen(PORT, HOST, () => {
    console.log(`[web] Steam Tags Explorer on http://${HOST}:${PORT}/`);
  });
}

async function start() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.error(`[web] no catalog to read: ${SNAPSHOT_PATH} is missing.`);
    console.error('');
    console.error('[web] that file is committed in this repository, so a checkout always has it:');
    console.error('[web]   git checkout -- public/data/catalog.bin.gz');
    console.error('[web] `npm run update-snapshot` then brings it up to date with Steam in place.');
    process.exit(1);
  }
  console.log(`[index] loading ${path.relative(ROOT, SNAPSHOT_PATH)}`);
  const t0 = Date.now();
  await loadCatalogSnapshot({
    bytes: new Uint8Array(fs.readFileSync(SNAPSHOT_PATH)),
    log: (m) => console.log(`[index] ${m}`),
  });
  indexMs = Date.now() - t0;
  console.log(`[index] ${store.nGames} games, ${store.nTags} tags, ${store.nLinks} links in ${indexMs}ms`);
  notePartialCatalog();
  logBandGaps();

  // What /api/meta reports about where this index came from. Saved combinations
  // live in each browser, so this server has no list to count.
  configureEngine({ origin: path.relative(ROOT, SNAPSHOT_PATH), indexedMs: indexMs, savedCount: () => 0 });
  listen();
}

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[web] ${signal}, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
