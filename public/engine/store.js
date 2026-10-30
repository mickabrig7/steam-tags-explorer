/**
 * The in-memory index, and everything that only ever reads from it.
 *
 * This module is **portable**: it must load unchanged in Node and in a browser.
 * It has no `node:` imports and no `process` reference, because the GitHub Page
 * runs the exact same combination engine the local server does — the only
 * difference is which home calls it.
 *
 * The catalog → typed-array loading step lives in `public/js/browser-index.js`,
 * which fills the single `store` shape documented below. `combos.js` counts against it, and `engine.js` turns those counts into
 * the JSON payloads every client reads.
 */

export const store = {
  loaded: false,
  loadedAt: null,
  loadMs: 0,

  nTags: 0,
  nGames: 0,
  nLinks: 0,

  tagIdOf: null, // index -> steam tag id
  tagIndexOf: new Map(), // steam tag id -> index
  tagName: [],
  tagCount: null, // index -> number of games carrying the tag
  postings: [], // index -> Int32Array of app ids (ascending)

  appIdOf: null, // row -> steam app id
  rowOfApp: new Map(), // steam app id -> row
  nameOf: [],
  reviewsOf: null,
  pctOf: null, // -1 when unknown
  labelOf: null,
  yearOf: null, // 0 when unknown
  flagsOf: null, // bit0 free, bit1 early access
  tagCountOfApp: null,
  appTagStart: null,
  appTagFlat: null,

  pairOf: null, // Map key(i,j) -> count ; key = i * PAIR_BASE + j, i < j
  pairKeys: null, // Int32Array of pair keys sorted by count ascending
  pairCounts: null, // Int32Array parallel to pairKeys

  meta: new Map(),
  lastSync: null,
};

// Tag count is far below this. Exported because the snapshot format mirrors the
// assumption: `public/engine/snapshot.js` refuses to write at the base rather than
// ship silently colliding pair keys.
export const PAIR_BASE = 1024;
export function pairKey(i, j) {
  return i < j ? i * PAIR_BASE + j : j * PAIR_BASE + i;
}
export function pairParts(key) {
  return [Math.floor(key / PAIR_BASE), key % PAIR_BASE];
}

/* ------------------------------------------------------------------ *
 * Review labels                                                       *
 * ------------------------------------------------------------------ */

// Index = the code stored in `store.labelOf` (in-memory only; the catalog file keeps
// the label as text). Every label Steam uses has a row here, including the `Mostly …`
// pair that `deriveLabel` can produce.
const REVIEW_LABELS = [
  '',
  'No Reviews',
  'Positive',
  'Very Positive',
  'Overwhelmingly Positive',
  'Mixed',
  'Mostly Positive',
  'Mostly Negative',
  'Negative',
  'Very Negative',
  'Overwhelmingly Negative',
];
const LABEL_CODES = new Map([
  ['', 1],
  ['no_reviews', 1],
  ['positive', 2],
  ['very_positive', 3],
  ['overwhelmingly_positive', 4],
  ['mixed', 5],
  ['mostly_positive', 6],
  ['mostly_negative', 7],
  ['negative', 8],
  ['very_negative', 9],
  ['overwhelmingly_negative', 10],
]);

export function reviewLabel(code) {
  return REVIEW_LABELS[code] ?? 'No Reviews';
}

/** Label code for a text label, shared by the snapshot writer and its readers. */
export function labelCode(text) {
  return LABEL_CODES.get(text || '') ?? 1;
}

/**
 * Older crawls stored `No Reviews` for games that plainly have thousands of them,
 * so the numbers win whenever the stored label contradicts them. `null` means
 * "no rating yet" and the interface simply leaves the badge out.
 */
export function deriveLabel(reviews, percent, stored) {
  const count = Number.isFinite(reviews) ? reviews : 0;
  if (count <= 0) return 'No Reviews';
  if (stored && stored !== 'No Reviews') return stored;
  if (percent === null) return null;
  if (count >= 500 && percent >= 95) return 'Overwhelmingly Positive';
  if (percent >= 80) return 'Very Positive';
  if (percent >= 70) return 'Positive';
  if (percent >= 40) return 'Mostly Positive';
  if (percent >= 20) return 'Mostly Negative';
  return 'Negative';
}

/* ------------------------------------------------------------------ *
 * Set maths on posting lists                                          *
 * ------------------------------------------------------------------ */

const EMPTY = new Int32Array(0);

function lowerBound(arr, value, from = 0) {
  let lo = from;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Intersection of two ascending Int32Arrays. Adaptive merge / galloping probe. */
export function intersect(a, b) {
  if (a.length === 0 || b.length === 0) return EMPTY;
  if (a.length > b.length) {
    const t = a;
    a = b;
    b = t;
  }
  if (a.length * 12 < b.length) {
    const out = new Int32Array(a.length);
    let n = 0;
    let lo = 0;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      lo = lowerBound(b, v, lo);
      if (lo < b.length && b[lo] === v) out[n++] = v;
      if (lo >= b.length) break;
    }
    return out.subarray(0, n);
  }
  const out = new Int32Array(a.length);
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x === y) {
      out[n++] = x;
      i++;
      j++;
    } else if (x < y) i++;
    else j++;
  }
  return out.subarray(0, n);
}

/**
 * App ids carrying every tag index in `tags`.
 * `tags` may be in any order; the first element is chosen by posting size.
 */
export function gamesWithAll(tags) {
  if (tags.length === 0) return allAppIds();
  const order = [...tags].sort((x, y) => store.tagCount[x] - store.tagCount[y]);
  let cur = store.postings[order[0]];
  for (let i = 1; i < order.length && cur.length > 0; i++) cur = intersect(cur, store.postings[order[i]]);
  return cur;
}

let allAppCache = null;
export function allAppIds() {
  if (!allAppCache) allAppCache = Int32Array.from(store.appIdOf);
  return allAppCache;
}

/** The cache is only valid for one filled index; whoever refills `store` calls this. */
export function resetAllAppCache() {
  allAppCache = null;
}

/** Tag indexes of one game, ascending. */
export function tagsOfRow(r) {
  const start = store.appTagStart[r];
  return store.appTagFlat.subarray(start, store.appTagStart[r + 1]);
}

export function pairCountIdx(i, j) {
  const c = store.pairOf.get(pairKey(i, j));
  return c === undefined ? 0 : c;
}

/* ------------------------------------------------------------------ *
 * View models                                                         *
 * ------------------------------------------------------------------ */

export function gameView(appId, includeTags = false) {
  const r = store.rowOfApp.get(appId);
  if (r === undefined) return null;
  const reviews = store.reviewsOf[r];
  const percent = store.pctOf[r] >= 0 ? store.pctOf[r] : null;
  const g = {
    app_id: store.appIdOf[r],
    name: store.nameOf[r],
    reviews,
    review_percent: percent,
    review_label: deriveLabel(reviews, percent, reviewLabel(store.labelOf[r])),
    year: store.yearOf[r] || null,
    is_free: (store.flagsOf[r] & 1) === 1,
    is_early_access: (store.flagsOf[r] & 2) === 2,
    tags: store.tagCountOfApp[r],
    url: `https://store.steampowered.com/app/${store.appIdOf[r]}/`,
  };
  if (includeTags) {
    g.all_tags = [...tagsOfRow(r)].map((i) => ({ id: store.tagIdOf[i], name: store.tagName[i] }));
  }
  return g;
}

export function tagView(i, extra = {}) {
  return {
    id: store.tagIdOf[i],
    name: store.tagName[i],
    games: store.tagCount[i],
    ...extra,
  };
}
