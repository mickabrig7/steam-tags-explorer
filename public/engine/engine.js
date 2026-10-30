/**
 * The API: one implementation, two transports.
 *
 * Every handler takes a `URLSearchParams` and returns `{ status, body }`. The
 * local HTTP server (`server.js`) wraps that in `sendJson`/`sendError`; the
 * GitHub Page calls the identical functions from `public/js/local-api.js` with
 * no network hop at all. That is what keeps the hosted site's numbers the same
 * numbers the local app produces — same beam search, same pruning, same
 * clamping, same view shaping.
 *
 * Portable by the same rule as `store.js`: no `node:` imports, no `process`.
 * Anything that differs between the two homes (which catalog file was read, how
 * long indexing took, where saved combinations live) arrives through
 * `configureEngine`.
 */

import { store, tagView, gameView, gamesWithAll } from './store.js';
import { serializeTiers } from './tiers.js';
import {
  resolveTagIds,
  comboSummary,
  suggestTags,
  scanSpaces,
  drawCombo,
  listCases,
  selectGames,
  bandAvailability,
  draftPoolView,
  draftDraw,
} from './combos.js';

/* ------------------------- what the two homes differ ------------------------- */

const ctx = {
  // Where the index came from. A path on a desk, a snapshot's crawl stamp online.
  origin: null,
  indexedMs: 0,
  // Saved combinations belong to the transport: a table for a local app that has
  // one, this browser's storage on the hosted page. /api/meta only reports how
  // many there are.
  savedCount: () => 0,
};

export function configureEngine(next = {}) {
  Object.assign(ctx, next);
}

/** Which rarity bands each mix length can reach, keyed by mix length. */
export function bandGaps() {
  const gaps = {};
  for (const n of [2, 3, 4, 5]) gaps[n] = bandAvailability(n);
  return gaps;
}

/* --------------------------------- helpers --------------------------------- */

const ok = (body) => ({ status: 200, body });
const fail = (message, status = 400) => ({ status, body: { error: message } });

/** Tag ids come in as "19,9" or "19|9" or repeated `tags` params. */
export function tagIdsFrom(params, name = 'tags') {
  const raw = [];
  for (const value of params.getAll(name)) raw.push(...value.split(/[,\s|]+/));
  return resolveTagIds(raw);
}

function intParam(params, name, fallback = null) {
  const v = params.get(name);
  if (v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi, fallback) {
  if (n === null || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function boolParam(params, name, fallback = false) {
  const v = params.get(name);
  if (v === null) return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

/** Turn one saved row (a JSON array of sorted tag ids) into what the page reads. */
export function spaceRowToView(row) {
  let ids = [];
  try {
    ids = JSON.parse(row.tags);
  } catch {
    /* corrupt row: skip */
  }
  const resolved = resolveTagIds(ids);
  return {
    id: row.id,
    created_at: row.created_at,
    tags: resolved.ok.map((i) => tagView(i)),
    unresolved: resolved.bad,
  };
}

/** The saved row a set of tag ids makes: the sorted id set *is* the whole row. */
export function spaceFromBody(body) {
  const raw = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(/[,\s|]+/);
  const { ok: indexes, bad } = resolveTagIds(raw);
  if (!indexes.length) return { error: 'No valid tag ids.' };
  const ids = indexes.map((i) => store.tagIdOf[i]).sort((a, b) => a - b);
  return { ids, unresolved: bad };
}

/* --------------------------------- handlers -------------------------------- */

export function metaHandler() {
  return ok({
    app: 'Steam Tags Explorer',
    games: store.nGames,
    tags: store.nTags,
    links: store.nLinks,
    pairs: store.pairKeys ? store.pairKeys.length : 0,
    indexed_ms: ctx.indexedMs,
    catalog: ctx.origin,
    last_sync: store.lastSync,
    saved_spaces: ctx.savedCount(),
    tiers: serializeTiers(),
    band_gaps: bandGaps(),
    cases: listCases(),
  });
}

export function tagsHandler(params) {
  const raw = (params.get('q') || '').trim().toLowerCase();
  // "coop" should still find "Co-op" and "storyrich" should find "Story Rich".
  const needle = raw.replace(/[^a-z0-9]/g, '');
  const limit = clamp(intParam(params, 'limit', 40), 1, 500, 40);
  const out = [];
  for (let i = 0; i < store.nTags; i++) {
    const name = store.tagName[i];
    if (name.startsWith('Tag_')) continue;
    if (!needle) {
      out.push(tagView(i));
      continue;
    }
    const lower = name.toLowerCase();
    const compact = lower.replace(/[^a-z0-9]/g, '');
    if (!compact.includes(needle)) continue;
    const rank = lower === raw || compact === needle ? 0 : lower.startsWith(raw) || compact.startsWith(needle) ? 1 : 2;
    out.push({ ...tagView(i), rank });
  }
  out.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.games - a.games);
  for (const item of out) delete item.rank;
  return ok({ total: out.length, tags: out.slice(0, limit) });
}

export function comboHandler(params) {
  const { ok: indexes, bad } = tagIdsFrom(params);
  if (!indexes.length) return fail('pass at least one tag id in ?tags=');
  const opts = {
    limit: clamp(intParam(params, 'limit', 24), 1, 100, 24),
    offset: clamp(intParam(params, 'offset', 0), 0, 1_000_000, 0),
    withVariants: boolParam(params, 'variants', true),
  };
  const combo = comboSummary(indexes, opts);
  return ok({ combo, unresolved: bad });
}

export function gamesHandler(params) {
  const { ok: indexes, bad } = tagIdsFrom(params);
  if (!indexes.length) return fail('pass at least one tag id in ?tags=');
  const limit = clamp(intParam(params, 'limit', 24), 1, 200, 24);
  const offset = clamp(intParam(params, 'offset', 0), 0, 1_000_000, 0);
  const games = gamesWithAll(indexes);
  const sel = selectGames(games, limit, offset);
  return ok({
    total: sel.total,
    limit,
    offset,
    games: sel.rows.map((r) => gameView(store.appIdOf[r])),
    unresolved: bad,
  });
}

export function suggestHandler(params) {
  const { ok: indexes, bad } = tagIdsFrom(params);
  if (!indexes.length) return fail('pass at least one tag id in ?tags=');
  const mode = params.get('mode') || 'rarest';
  if (!['rarest', 'potential', 'audience'].includes(mode)) return fail('mode must be rarest|potential|audience');
  const out = suggestTags(indexes, {
    mode,
    limit: clamp(intParam(params, 'limit', 12), 1, 40, 12),
    maxCount: clamp(intParam(params, 'maxCount', 20000), 1, 200000, 20000),
    minCount: clamp(intParam(params, 'minCount', 1), 0, 200000, 1),
  });
  return ok({ ...out, unresolved: bad });
}

export function scanHandler(params) {
  const must = tagIdsFrom(params, 'must');
  if (must.bad.length) return fail(`unknown tag ids: ${must.bad.join(', ')}`);
  // Mix length 2..5, the same range every mode offers in its controls.
  const k = clamp(intParam(params, 'k', 3), 2, 5, 3);
  const minCount = clamp(intParam(params, 'minCount', 1), 0, 500000, 1);
  // maxCount 0 is meaningful: it asks for the Empty band only.
  const maxCount = clamp(intParam(params, 'maxCount', 12), 0, 500000, 12);
  if (maxCount < minCount) return fail('maxCount must be >= minCount');
  const rankBy = params.get('rankBy') || 'potential';
  if (!['potential', 'rarest', 'audience', 'random'].includes(rankBy)) {
    return fail('rankBy must be potential|rarest|audience|random');
  }
  const out = scanSpaces({
    k,
    minCount,
    maxCount,
    mustTags: must.ok,
    includeEmpty: boolParam(params, 'includeEmpty', false),
    rankBy,
    limit: clamp(intParam(params, 'limit', 24), 1, 60, 24),
    // A page of the board, not the whole board: `combos.js` builds `offset + limit`
    // cards and answers with the slice. The ceiling on that is the search's, not
    // the router's, so an oversized offset is clamped there rather than rejected here.
    offset: clamp(intParam(params, 'offset', 0), 0, 1000, 0),
    // How many cards the whole search commits to. A client that pages repeats the same
    // number on every page — that is what keeps page 2 a tail of page 1 instead of a
    // different roll of the same dice. 0 means "one page is all I wanted".
    board: clamp(intParam(params, 'board', 0), 0, 200, 0),
    gamesPerSpace: clamp(intParam(params, 'gamesPerSpace', 4), 0, 12, 4),
    // How deep to dig is the search's decision now (it follows the length of the mix),
    // so an absent `thoroughness` is the normal Finder request. The crate, the
    // Empty-combinations sweep and a hand-written curl can still ask for a depth.
    thoroughness: params.get('thoroughness') == null
      ? undefined
      : clamp(intParam(params, 'thoroughness', 2), 1, 3, 2),
    emptyFloor: clamp(intParam(params, 'emptyFloor', 150), 1, 50000, 150),
    seed: clamp(intParam(params, 'seed', 0), 0, 2_000_000_000, 0),
  });
  return ok(out);
}

/** `bias` and `forceBand` are validated the same way for both rolling panels. */
function rollParams(params) {
  const bias = params.get('bias') || 'balanced';
  if (!['balanced', 'seeker', 'magnet'].includes(bias)) return { error: 'bias must be balanced|seeker|magnet' };
  const forceBand = params.get('forceBand');
  if (forceBand) {
    const known = serializeTiers().some((t) => t.id === forceBand);
    if (!known) return { error: 'forceBand must be one of ' + serializeTiers().map((t) => t.id).join('|') };
  }
  const avoid = (params.get('avoid') || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
  return { bias, forceBand, avoid };
}

export function drawHandler(params) {
  const k = clamp(intParam(params, 'k', 3), 2, 5, 3);
  const roll = rollParams(params);
  if (roll.error) return fail(roll.error);
  const out = drawCombo({
    k,
    caseId: params.get('case') || 'wildcard',
    bias: roll.bias,
    forcedTier: roll.forceBand || null,
    avoid: roll.avoid,
  });
  if (!out) return fail('No combination matched this band. Try a lower band or fewer tags.', 404);
  return ok(out);
}

export function casesHandler() {
  return ok({ cases: listCases() });
}

/** A draft pool is counted in full, so both ends of its size stay bounded. */
function draftParams(params) {
  return {
    caseId: params.get('case') || 'wildcard',
    shown: clamp(intParam(params, 'shown', 16), 6, 20, 16),
    k: clamp(intParam(params, 'k', 3), 2, 5, 3),
    seed: clamp(intParam(params, 'seed', 0), 0, 2_000_000_000, 0),
  };
}

export function draftTagsHandler(params) {
  const disabled = tagIdsFrom(params, 'disabled');
  if (disabled.bad.length) return fail(`Unknown tag: ${disabled.bad.join(', ')}`);
  const out = draftPoolView({ ...draftParams(params), disabled: disabled.ok });
  if (out && out.error) return fail(out.error);
  if (!out) return fail('Too many tag combinations in this pool to count exactly. Use fewer tags.', 400);
  return ok(out);
}

export function draftDrawHandler(params) {
  const draft = draftParams(params);
  const roll = rollParams(params);
  if (roll.error) return fail(roll.error);
  const disabled = tagIdsFrom(params, 'disabled');
  if (disabled.bad.length) return fail(`Unknown tag: ${disabled.bad.join(', ')}`);
  const out = draftDraw({
    ...draft,
    disabled: disabled.ok,
    bias: roll.bias,
    forcedTier: roll.forceBand || null,
    avoid: roll.avoid,
  });
  if (out && out.error) return fail(out.error);
  if (!out) return fail('No tag combination in the pool matched this band. Choose another band.', 404);
  return ok(out);
}

/** Every read route, in the order the local router matches them. */
export const handlers = [
  { pattern: /^\/api\/meta$/, handler: metaHandler },
  { pattern: /^\/api\/tags$/, handler: tagsHandler },
  { pattern: /^\/api\/combo$/, handler: comboHandler },
  { pattern: /^\/api\/games$/, handler: gamesHandler },
  { pattern: /^\/api\/suggest$/, handler: suggestHandler },
  { pattern: /^\/api\/scan$/, handler: scanHandler },
  { pattern: /^\/api\/draw$/, handler: drawHandler },
  { pattern: /^\/api\/cases$/, handler: casesHandler },
  { pattern: /^\/api\/draft\/tags$/, handler: draftTagsHandler },
  { pattern: /^\/api\/draft\/draw$/, handler: draftDrawHandler },
];
