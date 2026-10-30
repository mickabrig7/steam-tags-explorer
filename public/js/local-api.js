/**
 * This is the whole transport: the same engine handlers the local server routes
 * to, called as plain functions with no network hop. `scripts/check-catalog.js`
 * answers the same battery of queries straight out of `data/catalog.bin.gz`,
 * which is what proves the page and the server answer the same question.
 *
 * The one thing with no HTTP equivalent is saved combinations: on a hosted page
 * they belong to this browser rather than to a file the visitor does not own.
 */

import {
  configureEngine,
  handlers,
  spaceRowToView,
  spaceFromBody,
} from '../engine/engine.js';
import { store } from '../engine/store.js';

const SPACES_KEY = 'steamtage:spaces';

/** Ask the engine one route, exactly as the router would. */
function call(path, params = new URLSearchParams()) {
  const found = handlers.find((h) => h.pattern.test(path));
  if (!found) throw new Error(`no such query: ${path}`);
  const result = found.handler(params instanceof URLSearchParams ? params : new URLSearchParams(params));
  if (result.status !== 200) {
    const err = new Error((result.body && result.body.error) || `request failed (${result.status})`);
    err.status = result.status;
    err.payload = result.body;
    throw err;
  }
  return result.body;
}

/** Turn the option objects the panels pass into the query string the handlers read. */
function paramsOf(options = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  return params;
}

/* ------------------------------ saved combinations ------------------------------
 * Same rows, same rules: the sorted set of tag ids is the whole row, so saving a
 * combination twice hands back the one that is already there. It lives in this
 * browser, which is also why it survives a reload and not a different laptop.
 * ----------------------------------------------------------------------------- */

function readRows() {
  try {
    const raw = window.localStorage.getItem(SPACES_KEY);
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeRows(rows) {
  try {
    window.localStorage.setItem(SPACES_KEY, JSON.stringify(rows));
  } catch {
    // A browser refusing storage (private mode, quota) must not take the page down:
    // the panel reports the save as failed through the error below.
    throw new Error('this browser will not store saved combinations');
  }
}

function listSpaceRows() {
  return readRows().slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);
}

function saveSpaceRow(tagIds) {
  const parsed = spaceFromBody({ tags: tagIds });
  if (parsed.error) throw Object.assign(new Error(parsed.error), { status: 400 });
  const tagsJson = JSON.stringify(parsed.ids);
  const rows = readRows();
  const existing = rows.find((row) => row.tags === tagsJson);
  if (existing) return spaceRowToView(existing);
  const row = {
    id: rows.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1,
    tags: tagsJson,
    created_at: new Date().toISOString(),
  };
  writeRows([...rows, row]);
  return spaceRowToView(row);
}

/** What /api/meta reports for `saved_spaces`, wired into the engine's context. */
export function configureLocalEngine(snapshot) {
  configureEngine({
    origin: snapshot && snapshot.header ? `snapshot built ${snapshot.header.generated_at}` : 'snapshot',
    indexedMs: snapshot ? snapshot.loadMs : 0,
    savedCount: () => readRows().length,
  });
}

export const api = {
  meta: async () => call('/api/meta'),
  tags: async (q, limit = 12) => call('/api/tags', paramsOf({ q, limit })),
  combo: async (tags, opts = {}) => call('/api/combo', paramsOf({ tags: tags.join(','), ...opts })),
  games: async (tags, opts = {}) => call('/api/games', paramsOf({ tags: tags.join(','), ...opts })),
  suggest: async (tags, opts = {}) => call('/api/suggest', paramsOf({ tags: tags.join(','), ...opts })),
  scan: async (params) => call('/api/scan', paramsOf(params)),
  draw: async (params) => call('/api/draw', paramsOf(params)),
  cases: async () => call('/api/cases'),
  draftTags: async (params) => call('/api/draft/tags', paramsOf(params)),
  draftDraw: async (params) => call('/api/draft/draw', paramsOf(params)),

  spaces: async () => ({ spaces: listSpaceRows().map(spaceRowToView) }),
  saveSpace: async (tagIds) => ({ space: saveSpaceRow(tagIds) }),
  deleteSpace: async (id) => {
    const rows = readRows();
    const kept = rows.filter((row) => Number(row.id) !== Number(id));
    if (kept.length === rows.length) {
      throw Object.assign(new Error('No such saved combination.'), { status: 404 });
    }
    writeRows(kept);
    return { deleted: 1 };
  },
};

/** A one-line summary of the index this page is answering from, for the log. */
export function describeIndex() {
  return `${store.nGames.toLocaleString()} games · ${store.nTags} tags · ${store.nLinks.toLocaleString()} links · `
    + `catalog synced ${store.lastSync || 'unknown'}`;
}
