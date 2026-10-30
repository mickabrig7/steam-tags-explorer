/**
 * Combination engine.
 *
 * Two search paths, both reporting exact game counts:
 *  - anchored beam search: you picked tags, we walk outwards and intersect
 *    real posting lists for every candidate (cheap, because rare prefixes have
 *    few games left to walk through).
 *  - unanchored scan: no tags picked yet, so we explore the tag space using
 *    pair counts as an admissible bound (count(A,B,C) <= count(A,B), etc.) and
 *    only pay for intersections on the shortlist.
 *  - draft pick: a small pool of tags chosen for one user, counted in full, so
 *    every band that exists inside that pool is known exactly.
 */

import {
  store,
  gamesWithAll,
  intersect,
  pairKey,
  pairParts,
  pairCountIdx,
  gameView,
  tagView,
  tagsOfRow,
  allAppIds,
} from './store.js';
import { tierForCount, TIERS } from './tiers.js';

/* ------------------------------ diagnostics ------------------------------ */

/**
 * `SCAN_DEBUG=1` in Node, or `globalThis.SCAN_DEBUG = 1` from a browser console.
 * Node's env has to be read at call time, and `process` does not exist on the
 * GitHub Page, so the env is looked up only when something already looks debug-y.
 */
export function scanDebug() {
  if (globalThis.SCAN_DEBUG) return true;
  return typeof process !== 'undefined' && !!process.env?.SCAN_DEBUG;
}

/* ------------------------------ helpers ------------------------------ */

export function comboKey(tagIdxs) {
  return [...tagIdxs].sort((a, b) => a - b).join(',');
}

/** Map raw steam tag ids -> internal tag indexes, reporting anything unknown. */
export function resolveTagIds(raw) {
  const ok = [];
  const bad = [];
  const seen = new Set();
  for (const value of raw) {
    const text = String(value ?? '').trim();
    // A blank piece is nothing asked for, not tag 0.
    if (!text) continue;
    const id = Number(text);
    if (!Number.isInteger(id)) continue;
    const idx = store.tagIndexOf.get(id);
    if (idx === undefined) {
      bad.push(id);
      continue;
    }
    if (seen.has(idx)) continue;
    seen.add(idx);
    ok.push(idx);
  }
  ok.sort((a, b) => a - b);
  return { ok, bad };
}

/** Tags the crawler never got a name for: kept in counts, kept out of the pools. */
let hiddenFlags = null;
export function isHiddenTag(i) {
  if (!hiddenFlags) {
    hiddenFlags = new Uint8Array(store.nTags);
    for (let i = 0; i < store.nTags; i++) {
      hiddenFlags[i] = /^Tag_\d+$/i.test(store.tagName[i]) ? 1 : 0;
    }
  }
  return hiddenFlags[i] === 1;
}

/** Mean "positive review volume" of a game row. */
function demandOfRow(r) {
  const reviews = store.reviewsOf[r];
  if (reviews <= 0) return 0;
  const pct = store.pctOf[r] >= 0 ? store.pctOf[r] : 70;
  return (reviews * pct) / 100;
}

let tagDemandProxy = null;
/** Average demand of the games carrying a tag: cheap stand-in until the real games are known. */
export function tagDemandProxyArr() {
  if (tagDemandProxy) return tagDemandProxy;
  tagDemandProxy = new Float64Array(store.nTags);
  const postings = store.postings;
  for (let i = 0; i < store.nTags; i++) {
    const list = postings[i];
    if (list.length === 0) continue;
    const step = Math.max(1, Math.floor(list.length / 400));
    let sum = 0;
    let n = 0;
    for (let k = 0; k < list.length; k += step) {
      const r = store.rowOfApp.get(list[k]);
      if (r === undefined) continue;
      sum += demandOfRow(r);
      n++;
    }
    tagDemandProxy[i] = n ? sum / n : 0;
  }
  return tagDemandProxy;
}

function heatFromDemand(avgDemand) {
  const d = Number(avgDemand);
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Math.max(0, Math.min(1, Math.log10(1 + d) / 4.2));
}

/**
 * Openness is measured on one fixed scale everywhere: how untouched a
 * combination is relative to the part of Steam that is well covered (20k games).
 */
const OPENNESS_CAP = 20000;

function scarcityFromCount(count, cap = OPENNESS_CAP) {
  if (count === 0) return 1;
  const c = Math.max(cap, 10);
  return Math.max(0, 1 - Math.log10(count + 1) / Math.log10(c + 1));
}

export function potentialOf(count, avgDemand) {
  const s = scarcityFromCount(count);
  const h = heatFromDemand(avgDemand);
  return {
    potential: Math.round(100 * (0.6 * s + 0.4 * h)),
    openness: Math.round(100 * s),
    heat: Math.round(100 * h),
  };
}

function meanDemandOf(appIds) {
  if (appIds.length === 0) return 0;
  const step = Math.max(1, Math.floor(appIds.length / 30));
  let sum = 0;
  let n = 0;
  for (let i = 0; i < appIds.length; i += step) {
    const r = store.rowOfApp.get(appIds[i]);
    if (r === undefined) continue;
    sum += demandOfRow(r);
    n++;
  }
  return n ? sum / n : 0;
}

/* --------------------------- games under a combination --------------------------- */

/**
 * Exact, over one combination's own games: how many of them there are, and the
 * review volume they carry. No sampling — these are the numbers the audience
 * ranking orders a board by.
 */
function matchStats(appIds) {
  let total = 0;
  let demand = 0;
  let reviews = 0;
  for (let i = 0; i < appIds.length; i++) {
    const r = store.rowOfApp.get(appIds[i]);
    if (r === undefined) continue;
    total++;
    demand += demandOfRow(r);
    reviews += store.reviewsOf[r];
  }
  return { total, demand, reviews };
}

/**
 * App ids -> row indexes by review volume, most reviewed first, plus the total.
 * This is the one order the interface offers: the games under a card are the ones
 * with the most reviews, and "Show N more games" continues that same list.
 */
export function selectGames(appIds, limit = 24, offset = 0) {
  const rows = [];
  for (let k = 0; k < appIds.length; k++) {
    const r = store.rowOfApp.get(appIds[k]);
    if (r === undefined) continue;
    rows.push(r);
  }
  rows.sort((a, b) => store.reviewsOf[b] - store.reviewsOf[a]);
  return { total: rows.length, rows: rows.slice(offset, offset + limit) };
}

/* --------------------------- combo summary --------------------------- */

export function comboSummary(tagIdxs, { limit = 24, offset = 0, withVariants = true } = {}) {
  const tags = [...tagIdxs].sort((a, b) => a - b);
  const games = gamesWithAll(tags);
  const count = games.length;
  const tier = tierForCount(count);
  const sel = selectGames(games, limit, offset);

  let demandSum = 0;
  let statTrak = false;
  for (let k = 0; k < games.length; k++) {
    const r = store.rowOfApp.get(games[k]);
    if (r === undefined) continue;
    demandSum += demandOfRow(r);
    if (!statTrak && store.reviewsOf[r] >= 50000 && store.pctOf[r] >= 90) statTrak = true;
  }

  const out = {
    key: comboKey(tags),
    tags: tags.map((i) => tagView(i)),
    count,
    tier: { id: tier.id, name: tier.name, color: tier.color, glow: tier.glow, blurb: tier.blurb },
    oneIn: count > 0 ? Math.max(1, Math.round(store.nGames / count)) : null,
    stat_trak: statTrak,
    ...potentialOf(count, count ? demandSum / count : emptyNeighborDemand(tags)),
    games: sel.rows.map((r) => gameView(store.appIdOf[r])),
    limit,
    offset,
  };

  // An empty mix still gets a read on the crowd: the closest corners that *are*
  // occupied say how warm this gap would be if someone filled it.
  if (!count && tags.length > 1) out.neighbors = emptyNeighbors(tags);

  if (withVariants && tags.length > 1) {
    out.variants = tags.map((drop) => {
      const rest = tags.filter((t) => t !== drop);
      const c = gamesWithAll(rest).length;
      const tr = tierForCount(c);
      return {
        drop: tagView(drop),
        tags: rest.map((i) => tagView(i)),
        count: c,
        tier: { id: tr.id, name: tr.name, color: tr.color },
      };
    });
  }
  return out;
}

/* --------------------------- tag suggestions --------------------------- */

/**
 * Tags worth adding to the current combination.
 * Pair counts give an admissible upper bound, so exact work stays tiny.
 */
export function suggestTags(baseIdxs, { mode = 'rarest', limit = 12, maxCount = 20000, minCount = 1 } = {}) {
  const base = [...baseIdxs].sort((a, b) => a - b);
  const baseGames = base.length ? gamesWithAll(base) : allAppIds();
  const baseCount = baseGames.length;
  const proxy = tagDemandProxyArr();
  const allowHidden = base.some((i) => isHiddenTag(i));
  const banned = new Set(base);
  const wantZero = minCount === 0;

  const shortlist = [];
  for (let t = 0; t < store.nTags; t++) {
    if (banned.has(t)) continue;
    if (isHiddenTag(t) && !allowHidden) continue;
    let bound = Infinity;
    for (const x of base) {
      const pc = pairCountIdx(x, t);
      if (pc < bound) bound = pc;
    }
    if (!base.length) bound = store.tagCount[t];
    if (bound > maxCount) continue;
    if (!wantZero && bound === 0) continue;
    const games = intersect(baseGames, store.postings[t]);
    const count = games.length;
    if (count > maxCount || count < minCount) continue;
    if (count === baseCount) continue; // adds nothing: same games
    const avgDemand = meanDemandOf(games);
    const tr = tierForCount(count);
    shortlist.push({
      tag: tagView(t),
      count,
      tier: { id: tr.id, name: tr.name, color: tr.color },
      ...potentialOf(count, avgDemand),
      shrink: baseCount ? Math.round(100 * (1 - count / baseCount)) : 0,
      reach: store.tagCount[t],
    });
  }

  const rankers = {
    rarest: (a, b) => a.count - b.count || b.reach - a.reach,
    potential: (a, b) => b.potential - a.potential || a.count - b.count,
    audience: (a, b) => b.reach - a.reach || b.count - a.count,
  };
  shortlist.sort(rankers[mode] || rankers.rarest);
  const baseTier = tierForCount(baseCount);
  return {
    base_count: baseCount,
    base_tier: { id: baseTier.id, name: baseTier.name, color: baseTier.color },
    suggestions: shortlist.slice(0, limit),
  };
}

/* --------------------------- scan: uncharted spaces --------------------------- */

const SCAN_CACHE = new Map();
const SCAN_CACHE_MAX = 40;
const SCAN_TTL_MS = 5 * 60 * 1000;

function cacheGet(key) {
  const hit = SCAN_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SCAN_TTL_MS) {
    SCAN_CACHE.delete(key);
    return null;
  }
  SCAN_CACHE.delete(key);
  SCAN_CACHE.set(key, hit);
  return hit.value;
}
function cacheSet(key, value) {
  SCAN_CACHE.set(key, { key, at: Date.now(), value });
  if (SCAN_CACHE.size > SCAN_CACHE_MAX) {
    SCAN_CACHE.delete(SCAN_CACHE.keys().next().value);
  }
}

/** Tags a search may build mixes out of: every named tag, lightest-carrying first.
 *  `poolCap` is internal to `drawCombo`, which narrows the pool when aiming at a band. */
function candidatePool(poolCap) {
  const pool = [];
  for (let t = 0; t < store.nTags; t++) {
    if (isHiddenTag(t)) continue;
    if (poolCap && store.tagCount[t] > poolCap) continue;
    pool.push(t);
  }
  return pool.sort((a, b) => store.tagCount[a] - store.tagCount[b]);
}

const BEAM_WIDTHS = [1400, 3400, 7000];
const LEAF_CAPS = [800, 1600, 3000];
const NODE_BUDGETS = [700_000, 2_000_000, 4_500_000];

/**
 * How deep to dig when the caller has no opinion — which in the Finder is always the
 * case. The length of the mix picks the depth: a longer mix costs the beam more per
 * candidate, so it gets a shallower one. An explicit `thoroughness` still wins, and the
 * crate and the Missed opportunities sweep pass one on purpose.
 */
const AUTO_DEPTH = { 2: 3, 3: 3, 4: 2, 5: 2 };

export function autoThoroughness(k) {
  return AUTO_DEPTH[k] || 2;
}

/**
 * The most cards one search hands out across all of its pages. Paging walks the
 * best of what the beam **kept**; it is not a cursor into the whole tag space,
 * which at 5 tags is on the order of a hundred billion tag sets and does not
 * become walkable just because someone is willing to click. Say so in the UI.
 */
const MAX_BOARD = 150;

/**
 * The search's random stream: **xorshift128** (Marsaglia), its 128-bit state filled by running the
 * press's seed through a murmur3-style mixer (SplitMix32) four times.
 *
 * The mixer matters more than it looks. A counter-based generator primed with the bare seed emits a
 * stream whose early numbers are *correlated* across seeds: the search asks the same questions in the
 * same order, so two presses with different seeds land on mostly the same cards. Measured on the gap
 * sweep at length 3, two seeds shared 4 of 12 cards with the unmixed generator and 0 of 12 with this
 * one. (At length 2 some overlap survives for a different reason — the catalog holds only 209 of
 * those gaps at the default floor — and no stream can vary what is not there.)
 *
 * Two constraints to respect before changing this:
 * - **32-bit integer arithmetic only.** A press at length 4–5 draws 1–2 M numbers, and the same
 *   generator written over a 64-bit BigInt state costs ~290 ms per 2 M draws against ~10 for this.
 * - **The number of draws stays fixed for a given (seed, parameters).** The state advances as the
 *   search consumes it, so this is not a pure function of the seed: a caller that takes extra
 *   numbers from the stream afterwards changes what every later press with that seed answers.
 */
function seedStream(a) {
  let z = ((Number(a) >>> 0) + 0x9e3779b9) | 0;
  const mix = () => {
    z = (z + 0x9e3779b9) | 0;
    let x = z;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return (x ^ (x >>> 16)) >>> 0;
  };
  let s0 = mix();
  let s1 = mix();
  let s2 = mix();
  let s3 = mix();
  if (!(s0 | s1 | s2 | s3)) s0 = 0x6a2b9f43;
  return function next() {
    const t = (s0 ^ (s0 << 11)) >>> 0;
    s0 = s1;
    s1 = s2;
    s2 = s3;
    s3 = ((s3 ^ (s3 >>> 19)) ^ t) >>> 0;
    return ((s3 ^ s2) >>> 0) / 4294967296;
  };
}

/**
 * Scan for tag combinations with very few games carrying them.
 * `thoroughness` (1..3) controls beam width and work budget; leave it out and the
 * length of the mix picks it (see `AUTO_DEPTH`). A search builds one board — `board`
 * cards wide, `MAX_BOARD` at most — and `limit` plus `offset` answer with one page of
 * it, so the pages of a search are slices of one ranked list, not separate searches.
 * Every count reported is exact.
 */
export function scanSpaces(opts = {}) {
  const k = Math.max(2, Math.min(5, Number(opts.k) || 3));
  const minCountReq = Math.max(0, Number(opts.minCount ?? 1));
  const maxCount = Math.max(minCountReq, Number(opts.maxCount ?? 40));
  const includeEmpty = opts.includeEmpty === true || minCountReq === 0;
  const minCount = includeEmpty ? 0 : Math.max(1, minCountReq);
  // A search for empty combinations wants blanks for every card, not a share of them.
  const blankOnly = includeEmpty && minCount === 0 && maxCount === 0;
  const rankBy = ['potential', 'rarest', 'audience', 'random'].includes(opts.rankBy) ? opts.rankBy : 'potential';
  const limit = Math.max(4, Math.min(60, Number(opts.limit) || 24));
  const thoroughness = opts.thoroughness == null
    ? autoThoroughness(k)
    : Math.max(1, Math.min(3, Number(opts.thoroughness) || 2));
  // Paging. The board is built `want` cards wide and this request's page is sliced
  // out of it, so page 2 is the tail of the same roll instead of a new one: same
  // seed, same beam, same ranking, cards 25 to 48.
  // A caller that means to page declares the width once (`board`) and repeats it on
  // every page. That is not a detail: rebuild the board around a different width and
  // the reader meets the same card twice and never meets the one that fell out.
  const offset = Math.max(0, Math.min(MAX_BOARD - 1, Number(opts.offset) || 0));
  const want = Math.min(MAX_BOARD, Math.max(limit, Number(opts.board) || offset + limit));
  // The audience board searches the widest band, so it gets a tighter beam. The saving
  // is measurable on this catalog: a full-depth audience press at length 4 scans ~850k
  // candidates and answers in ~0.9 s, and at the depth the mix length picks it answers
  // in ~0.4 s. Without the tighter beam both numbers grow.
  const breadth = rankBy === 'audience' ? 0.6 : 1;

  const beamWidth = Math.max(300, Math.round(BEAM_WIDTHS[thoroughness - 1] * breadth));
  const leafCap = Math.max(200, Math.round(LEAF_CAPS[thoroughness - 1] * breadth));
  const nodeBudget = Math.round(NODE_BUDGETS[thoroughness - 1] * breadth);
  const poolCap = opts.poolCap == null ? 0 : Number(opts.poolCap) || 0;
  const must = [...(opts.mustTags || [])].sort((a, b) => a - b);
  const seed = Number(opts.seed) || 0;
  const rng = seedStream(seed || 0x9e3779b9);
  const jitter = () => 0.82 + 0.36 * rng();
  // `rankBy=random` samples the board instead of ranking it. Each combination the beam
  // turned up gets a roll from the same seeded stream the jitter uses, and those rolls
  // decide both which mixes survive into stage 2 and what order they arrive in. The beam
  // itself is left alone — it prunes on exact pair counts, so a random press is a random
  // sample of what the search considered, never an estimate of anything. `found`
  // and `count` keep their exact meaning under every ranking.
  const sampling = rankBy === 'random';

  const cacheKey = JSON.stringify({
    k,
    minCount,
    maxCount,
    includeEmpty,
    emptyFloor: Math.max(1, Number(opts.emptyFloor) || 150),
    rankBy,
    limit,
    offset,
    // The board width this request commits to. Two pages are only slices of the same
    // list if they were built from the same width, so the width belongs in the key.
    board: want,
    thoroughness,
    poolCap,
    maxTagReuse: opts.maxTagReuse,
    must,
    seed,
  });
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  const poolAll = candidatePool(poolCap);
  // The empty-combination mode asks for tags that each have a real audience; the
  // floor has to shape the search itself, not only the pair case.
  const emptyTagFloor = Math.max(1, Number(opts.emptyFloor) || 150);
  const pool = blankOnly
    ? poolAll.filter((t) => store.tagCount[t] >= emptyTagFloor)
    : poolAll;
  const proxy = tagDemandProxyArr();
  // A combination is never more common than its rarest pair, but a rare
  // combination can still be built from common pairs, so the beam bound loosens
  // as the combination gets longer instead of hugging maxCount. A mix is also
  // usually rarer than its rarest pair - each tag added cuts the crowd again,
  // roughly tenfold - so a mix that lands in a named band normally descends
  // from pairs a few steps busier than that band.
  const bandTargeted =
    Number.isFinite(maxCount) && maxCount > 0 && minCount > 0 && !includeEmpty;
  // The other kind of window: open at one end or both — *Any rarity*, *Prioritize rare* — where no
  // band is being aimed at. Nothing aims the walk, so it has to be told to keep branches that lead to
  // busy mixes as well as thin ones, or its answer can only ever be thin. The gap sweep is exempt:
  // its window is 0-to-0, one band, and thin branches are exactly what it is hunting (spreading it
  // cost it nearly half the gaps it finds — measured 1,572 down to 865 at length 3).
  const openWindow = !bandTargeted && !blankOnly;
  const bandMid = bandTargeted ? Math.sqrt(Math.max(1, minCount) * maxCount) : 0;
  const pairTarget = bandTargeted ? Math.min(bandMid * Math.pow(6, Math.max(0, k - 2)), 40000) : 0;
  // The ceiling on how busy a followed pair is allowed to be. For a rare window it does
  // real work: the walk through the hub tags is enormous and can never land in a rare
  // band. For a window that is itself busy it must not bite, because the busiest mixes in
  // the catalog are built from exactly its busiest pairs: a Very common mix of four tags
  // only exists down the busiest branches. The walk stays small
  // there anyway, because the *lower* bound (every pair of the mix at least `minCount`)
  // leaves a few hundred pairs in the whole catalog.
  const pairCeiling = Math.max(40_000, minCount * 10);
  const boundCap = includeEmpty
    ? Math.max(maxCount, 4000)
    : Math.min(
        Math.max(pairTarget * 3, maxCount * [0, 1, 1, 40, 160, 600][k], 1500),
        pairCeiling,
      );
  const bandLog = Math.log10(1 + Math.max(boundCap, 10));
  // A prefix may stay busier than the band while there are tags left to add.
  const prefixRoom = (length) =>
    bandTargeted ? maxCount * Math.pow(6, Math.max(0, k - length)) : Infinity;
  const t0 = Date.now();
  // Wall-clock cut-off: a crate press must answer even when the sweep is mid-flight.
  const hardStop = opts.deadlineMs ? t0 + Math.max(40, Number(opts.deadlineMs)) : 0;
  let nodes = 0;
  let truncated = false;

  // Every ranking keeps the branches that fit its own idea of good, but each branch
  // also carries a small random factor so branches that are close to each other swap
  // places from press to press. Without it a search that ranks by pair counts or by
  // review attention kept the same branches every time, and pressing search again
  // returned the same board. Pruning still uses the true bound, and the exact ranking
  // at the end still sorts what survived.
  const rankBeam = (a, b) => {
    if (rankBy === 'rarest') return a.bound * a.bias - b.bound * b.bias || b.heatProxy - a.heatProxy;
    // "Audience" means review attention, not tag population: ranking the beam by
    // tag counts would keep only hubs (Singleplayer, Action), and every hub mix
    // is already crowded, so a board of empty spaces built this way comes back blank.
    if (rankBy === 'audience') return b.heatProxy * b.bias - a.heatProxy * a.bias || a.bound - b.bound;
    return b.score - a.score || a.bound - b.bound;
  };
  const beamScore = (boundOrCount, heatProxy) =>
    0.6 * (1 - Math.log10(1 + boundOrCount) / bandLog) + 0.4 * heatFromDemand(heatProxy);
  // Scanning *towards a named band* needs the opposite instinct: keep branches
  // whose ancestry sits near the band's expected pair range, not the ones that
  // fade towards nothing.
  const branchScore = (meanPair, heatProxy) =>
    bandTargeted
      ? 0.6 *
          (1 - Math.abs(Math.log10((meanPair + 1) / (pairTarget + 1))) / bandLog) +
        0.4 * heatFromDemand(heatProxy)
      : beamScore(meanPair, heatProxy);

  const found = [];
  const seenKeys = new Set();
  const pushFound = (tags, count, exactGames, heatProxy) => {
    const key = comboKey(tags);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    // Only a sampling press pays for a roll; the other rankings keep spending their
    // random numbers on the beam jitter alone.
    found.push({ tags, count, exactGames: exactGames || null, heatProxy, roll: sampling ? rng() : 0 });
  };
  const pairHeat = (i, j) => Math.sqrt((proxy[i] * proxy[i] + proxy[j] * proxy[j]) / 2);

  const lowerBoundCount = (arr, v) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  if (must.length >= k) {
    // The tags you picked already are the combination.
    const games = gamesWithAll(must);
    pushFound(must, games.length, games, 0);
  } else if (k === 2) {
    // Pairs are stored exactly, so this needs no intersections at all.
    if (must.length === 1) {
      const anchor = must[0];
      for (const t of pool) {
        if (t === anchor) continue;
        const count = pairCountIdx(anchor, t);
        if (count > maxCount || count < minCount) continue;
        if (count === 0 && !includeEmpty) continue;
        nodes++;
        pushFound(
          [anchor, t],
          count,
          count ? intersect(store.postings[anchor], store.postings[t]) : new Int32Array(0),
          pairHeat(anchor, t),
        );
      }
    } else {
      const counts = store.pairCounts;
      const keys = store.pairKeys;
      const lo = lowerBoundCount(counts, Math.max(1, minCount));
      let hi = lowerBoundCount(counts, maxCount + 1);
      const cap = [4000, 14000, 34000][thoroughness - 1];
      const stride = Math.max(1, Math.ceil((hi - lo) / cap));
      for (let p = lo; p < hi; p += stride) {
        const [i, j] = pairParts(keys[p]);
        if (isHiddenTag(i) || isHiddenTag(j)) continue;
        nodes++;
        pushFound([i, j], counts[p], null, pairHeat(i, j));
      }
    }
    if (includeEmpty) {
      // Blank pairs between tag communities that each have a real audience:
      // two crowds that never met. 5,400+ of these exist at the >=150 floor.
      const strong = pool.filter((t) => store.tagCount[t] >= emptyTagFloor);
      for (let a = 0; a < strong.length; a++) {
        const i = strong[a];
        for (let b = a + 1; b < strong.length; b++) {
          const j = strong[b];
          nodes++;
          if (store.pairOf.has(pairKey(Math.min(i, j), Math.max(i, j)))) continue;
          pushFound([i, j], 0, null, pairHeat(i, j));
        }
      }
    }
  } else if (must.length >= 1) {
    // Anchored: exact game sets per beam (cheap once prefixes are rare).
    const mustSet = new Set(must);
    let seeds = [{ tags: must, free: [], lastFree: -1, games: gamesWithAll(must), heatSq: 0, meanPair: store.tagCount[must[0]] || 1 }];
    for (let depth = must.length; depth < k && seeds.length; depth++) {
      const next = [];
      for (const beam of seeds) {
        for (const t of pool) {
          if (t <= beam.lastFree) continue; // canonical order among the free slots
          if (mustSet.has(t)) continue;
          let bound = Infinity;
          let pairSum = 0;
          let skip = false;
          for (const x of beam.tags) {
            const pc = pairCountIdx(x, t);
            if (pc < bound) bound = pc;
            pairSum += pc;
            if (pc > boundCap || pc === 0) {
              skip = true;
              break;
            }
          }
          if (skip || bound < minCount) continue;
          if (++nodes > nodeBudget || (hardStop && (nodes & 63) === 0 && Date.now() > hardStop)) {
            truncated = true;
            break;
          }
          const games = intersect(beam.games, store.postings[t]);
          const n = beam.tags.length + 1;
          // A prefix is allowed to be busier than the band while tags are still
          // missing; the last slot is what has to land inside it.
          if (games.length < minCount || games.length > prefixRoom(n)) continue;
          if (games.length === beam.games.length) continue; // tag narrows nothing
          const free = [...beam.free, t];
          const heatSq = beam.heatSq + proxy[t] * proxy[t];
          const meanPair = (beam.meanPair * ((n - 1) * (n - 2)) / 2 + pairSum) / (n * (n - 1) / 2);
          const bias = jitter();
          next.push({
            tags: [...must, ...free].sort((a, b) => a - b),
            free,
            lastFree: t,
            games,
            bound,
            meanPair,
            heatProxy: Math.sqrt(heatSq / free.length),
            heatSq,
            audienceProxy: free.reduce((s, x) => s + store.tagCount[x], 0),
            score: branchScore(Math.max(games.length, meanPair * 0.5), Math.sqrt(heatSq / free.length)) * bias,
            bias,
          });
        }
        if (truncated) break;
      }
      next.sort(rankBeam);
      seeds = openWindow ? spreadByBound(next, beamWidth) : next.slice(0, beamWidth);
    }
    for (const b of seeds) pushFound(b.tags, b.games.length, b.games, b.heatProxy);
  } else {
    // Unanchored: tag-space walk with admissible pair bounds, exact counts at the leaves.
    let level = pool.map((t) => ({
      tags: [t],
      bound: Infinity,
      meanPair: store.tagCount[t],
      heatProxy: proxy[t],
      heatSq: proxy[t] * proxy[t],
      audienceProxy: store.tagCount[t],
    }));
    for (let depth = 1; depth < k && level.length; depth++) {
      const next = [];
      for (const beam of level) {
        const last = beam.tags[beam.tags.length - 1];
        for (const t of pool) {
          if (t <= last) continue; // each combination is visited once, ascending
          let bound = beam.bound;
          let pairSum = 0;
          let skip = false;
          for (const x of beam.tags) {
            const pc = pairCountIdx(x, t);
            if (pc < bound) bound = pc;
            pairSum += pc;
            if (pc > boundCap || pc === 0) {
              skip = true;
              break;
            }
          }
          if (skip || bound < minCount) continue;
          if (++nodes > nodeBudget || (hardStop && (nodes & 63) === 0 && Date.now() > hardStop)) {
            truncated = true;
            break;
          }
          const heatSq = beam.heatSq + proxy[t] * proxy[t];
          const n = beam.tags.length + 1;
          // Mean pair rarity, so a tag that co-occurs with everything (Mod,
          // Singleplayer) cannot drag a whole board down its tail.
          const meanPair = (beam.meanPair * ((n - 1) * (n - 2)) / 2 + pairSum) / (n * (n - 1) / 2);
          const bias = jitter();
          next.push({
            tags: [...beam.tags, t],
            bound,
            meanPair,
            heatProxy: Math.sqrt(heatSq / n),
            heatSq,
            audienceProxy: beam.audienceProxy + store.tagCount[t],
            score: branchScore(meanPair, Math.sqrt(heatSq / n)) * bias,
            bias,
          });
        }
        if (truncated) break;
      }
      next.sort(rankBeam);
      // The same rule one level up, where the search decides what to *remember*: under an open
      // window the ranking pulls the beam towards the rarest pairs too, and a branch that was never
      // kept can never be counted later.
      level = openWindow ? spreadByBound(next, beamWidth) : next.slice(0, beamWidth);
    }
    // Which of the finished prefixes get their games counted. Under a window that names a band the
    // beam's own ranking is the right filter — those branches are already aimed at that band. Under
    // a window that is open at one end or the other (`Any rarity`, `Prioritize rare`) that ranking
    // pulls everything towards the rarest branches, so a straight top slice counts nothing but gaps
    // and one-game mixes, and the board it builds cannot show any other band. There the counted
    // leaves are dealt across the *pair rarity* each prefix descends from: the same number of
    // intersections spent, spread over branches whose exact counts land in different bands.
    for (const beam of pickLeaves(level, leafCap, openWindow)) {
      const count = gamesWithAll(beam.tags).length;
      if (count > maxCount || count < minCount) continue;
      pushFound(beam.tags, count, null, beam.heatProxy);
    }
  }

  // Stage 1: cheap proxy ranking (plus a blank quota) so exact scoring only
  // runs on a shortlist.
  const preRank = {
    rarest: (a, b) => a.count - b.count || b.heatProxy - a.heatProxy,
    // Which mixes are worth scoring exactly is a sample, not a ranking.
    random: (a, b) => a.roll - b.roll,
    // A "most played" board is about the crowd a mix carries, not the average
    // game inside it: heat is a per-tag mean, so it is multiplied by the mix's
    // own size to get a mass the exact stage-2 sums agree with.
    audience: (a, b) => b.heatProxy * b.count - a.heatProxy * a.count || b.heatProxy - a.heatProxy,
    potential: (a, b) =>
      0.6 * scarcityFromCount(a.count, maxCount) +
        0.4 * heatFromDemand(a.heatProxy) -
        (0.6 * scarcityFromCount(b.count, maxCount) + 0.4 * heatFromDemand(b.heatProxy)) || a.count - b.count,
  };
  found.sort(preRank[rankBy] || preRank.potential);
  // Wide enough for every page this search can hand out, not just the first one.
  const stage1Cap = Math.min(found.length, Math.max(80, want * 4));
  // A press does not take the same head of the ranking every time. A ranking with no roll in it —
  // the gap sweep's `potential` — put the same dozen gaps in front of the reader on every press,
  // which for a search whose entire point is *which* gaps exist is a button that does nothing. So a
  // seeded press shuffles a wide head of the ranking before the shortlist is taken: the cards shown
  // are a fresh sample from the top of the list, and the list they sit in is still the order the
  // mode claims, because stage 2 re-sorts what survived.
  const headWidth = Math.min(found.length, Math.max(stage1Cap, want * 8));
  const ranked = seed && !sampling
    ? shuffleHead(found, headWidth, rng).concat(found.slice(headWidth))
    : found;
  let blankCap = 0;
  if (blankOnly) blankCap = stage1Cap;
  else if (includeEmpty) blankCap = Math.max(2, Math.round(stage1Cap * 0.3));
  const shortlist = [];
  // Blanks never out-rank high-heat pairs on the demand proxy, so their share
  // of the shortlist is reserved rather than earned.
  for (const b of ranked) {
    if (shortlist.length >= stage1Cap - blankCap) break;
    if (b.count === 0) continue;
    shortlist.push(b);
  }
  if (blankCap) {
    let blanksTaken = 0;
    for (const b of ranked) {
      if (blanksTaken >= blankCap) break;
      if (b.count !== 0) continue;
      shortlist.push(b);
      blanksTaken++;
    }
  }

  // Stage 2: counts are already exact; now measure the real audience of each space.
  // `matchStats` counts the combination's own games, which is exactly the list the
  // card under it quotes.
  const scored = shortlist.map((b) => {
    const games = b.exactGames || gamesWithAll(b.tags);
    const stats = matchStats(games);
    const avgDemand = stats.total > 0 ? stats.demand / stats.total : emptyNeighborDemand(b.tags);
    const tier = tierForCount(b.count);
    return {
      tags: b.tags.map((i) => tagView(i)),
      count: b.count,
      demand_sum: stats.demand,
      avg_reviews: stats.total > 0 ? Math.round(stats.reviews / stats.total) : 0,
      tier: { id: tier.id, name: tier.name, color: tier.color, glow: tier.glow, blurb: tier.blurb },
      ...potentialOf(b.count, avgDemand),
      // Second roll, drawn after the first stage is over: the board's order is a fresh
      // sample of the shortlist, not a re-run of the stage-1 sample.
      ...(sampling ? { _roll: rng() } : {}),
      _idxs: b.tags,
      _games: games,
    };
  });

  const finalRank = {
    rarest: (a, b) => a.count - b.count || b.potential - a.potential,
    // A random board: two presses with different seeds land on different combinations,
    // and a press with the same seed lands on the same one (that is what makes paging
    // and a cached page 2 still agree). Nothing here is ranked by quality, so the tag
    // cap and the blank quota are the only forces shaping which cards make the board.
    random: (a, b) => a._roll - b._roll,
    potential: (a, b) => b.potential - a.potential || a.count - b.count,
    // Review activity in total, not on average: an average rewards a one-game mix
    // whose single game happens to be enormous, which is a fact about one game and
    // not about the combination.
    audience: (a, b) =>
      b.demand_sum - a.demand_sum || b.avg_reviews - a.avg_reviews || a.count - b.count,
  };
  scored.sort(finalRank[rankBy] || finalRank.potential);

  // Cap blank (zero-game) spaces, and stop one tag from filling the whole board.
  // The cap is a handful, not a share that grows with the board: an empty card is a
  // fact about the catalog, and once that fact is on the board twice or three times,
  // a wider board should spend its extra cards on combinations that have games.
  // (At lengths 4 and 5 the audience board is nearly all blanks anyway — the hottest
  // 4- and 5-tag sets are empty ones — so this is what keeps a long board readable.)
  const emptyQuota = blankOnly ? want : includeEmpty ? Math.max(2, Math.min(8, Math.round(want * 0.35))) : 0;
  const reuseCap = opts.maxTagReuse == null ? 2 : Math.max(1, Number(opts.maxTagReuse) || 1);
  const pinnedSet = new Set(must);
  const usedTags = new Map();
  // Every page this search can hand out is chosen here, in one list. That is what
  // makes a tag cap and a blank quota properties of the **board** rather than of one
  // page: page 2 may not lean on a tag page 1 already used up.
  // First the spread, when the window spans several bands: a board dealt band by band, so a press
  // under a wide window answers with thin and crowded mixes instead of nothing but gaps. When the
  // window sits inside one band — a guarantee, or the gap sweep — there is nothing to spread, and
  // the board is taken straight down the ranking.
  // The same rule one level up, where it decides what the reader actually sees: a ranked press with
  // a seed deals its board from a shuffled head of the scored list, not from its very top. At length
  // 2 the gap sweep has 209 answers in the whole catalog and a 72-card board to fill, so taking the
  // top 72 made every press answer the same page — a sample of that same 209 does not.
  const dealt = seed && !sampling
    ? shuffleHead(scored, Math.min(scored.length, want * 8), rng)
    : scored;
  let board = pickSpreadBoard(scored, want, emptyQuota, reuseCap, pinnedSet, usedTags);
  if (!board.length) board = pickDiverse(dealt, want, emptyQuota, reuseCap, pinnedSet, usedTags);
  // A demand-sorted board buries its blank spaces (an empty mix has no reviews of
  // its own), so the quota is topped up from the blanks that ranking pushed down.
  if (emptyQuota && board.filter((sp) => sp.count === 0).length < emptyQuota) {
    const blanksUsed = board.filter((sp) => sp.count === 0).length;
    board = board.concat(
      pickDiverse(scored.filter((sp) => sp.count === 0 && !board.includes(sp)), want - board.length, emptyQuota - blanksUsed, reuseCap, pinnedSet, usedTags),
    );
  }
  // A tag cap that leaves the board half empty is worse than a tag appearing a third
  // or fourth time: a board ranked by review attention is built from a handful of
  // tags that co-occur with everything, and holding them to two cards would show five
  // cards to someone who asked for seventy-two. The cap loosens one appearance at a
  // time, and only the last pass drops it.
  for (let cap = reuseCap + 1; board.length < want && cap <= reuseCap + 2; cap++) {
    const blanksUsed = board.filter((sp) => sp.count === 0).length;
    board = board.concat(
      pickDiverse(scored.filter((sp) => !board.includes(sp)), want - board.length, Math.max(0, emptyQuota - blanksUsed), cap, pinnedSet, usedTags),
    );
  }
  if (board.length < want) {
    const blanksUsed = board.filter((sp) => sp.count === 0).length;
    board = board.concat(
      pickDiverse(scored.filter((sp) => !board.includes(sp)), want - board.length, Math.max(0, emptyQuota - blanksUsed), Infinity, pinnedSet, usedTags),
    );
  }
  // The page is a slice of that board, never a fresh search: card 25 is the same
  // combination whether it arrives on the second page or in a request that asked for
  // the whole board at once. Only the games listed under it are built per page.
  // One order for the whole board, after every fill pass: the passes append, so without this a page
  // can run out of the ranking it is supposed to be read in. (The blank quota and the tag cap are
  // what decide which cards are on it; this decides what order they arrive in.)
  board.sort(finalRank[rankBy] || finalRank.potential);
  const boardTotal = board.length;
  const picked = board.slice(offset, offset + limit);

  if (scanDebug()) {
    console.error(`[scan] k=${k} rank=${rankBy} must=${must.join('/')} found=${found.length} shortlist=${shortlist.length} scored=${scored.length} board=${boardTotal} offset=${offset} picked=${picked.length} cap=${reuseCap} quota=${emptyQuota}`);
  }

  for (const space of picked) {
    const sel = selectGames(space._games, opts.gamesPerSpace || 4);
    space.games = sel.rows.map((r) => gameView(store.appIdOf[r]));
    // Cards quote their odds the same way everywhere, so a one-game mix reads as
    // a one-game mix instead of falling back to the blank-space phrasing.
    space.oneIn = space.count > 0 ? Math.max(1, Math.round(store.nGames / space.count)) : null;
    if (space.count === 0) space.neighbors = emptyNeighbors(space._idxs);
    delete space._idxs;
    delete space._games;
    delete space._roll;
  }

  const result = {
    k,
    minCount,
    maxCount,
    includeEmpty,
    rankBy,
    thoroughness,
    beamWidth,
    truncated,
    scanned_candidates: nodes,
    found: found.length,
    ms: Date.now() - t0,
    pool_size: pool.length,
    // The floor the pool was cut with. Only ever applied in the 0-to-0 window, but echoed
    // always so a client can say which tags a gap was searched among instead of repeating
    // the server default in its own copy.
    empty_floor: emptyTagFloor,
    // How many cards this search can hand out in total, and which slice of them the
    // request asked for. `spaces.length < board_total` is the client's signal that a
    // "More combinations" control belongs under the board.
    board_total: boardTotal,
    offset,
    spaces: picked,
    cached: false,
  };
  // A crate scan runs against a stopwatch; its cut-short version must not become
  // the answer a later Finder press reads out of the cache.
  if (!(hardStop && truncated)) cacheSet(cacheKey, result);
  return result;
}

/**
 * Shuffle the head of an already-ranked list with the press's own stream. The tail keeps its order:
 * only the part a press is choosing from gets re-ordered, so a board built from it is a sample of
 * the top of the ranking rather than a reshuffle of the whole answer.
 */
function shuffleHead(list, width, rng) {
  const head = list.slice(0, width);
  for (let i = head.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = head[i];
    head[i] = head[j];
    head[j] = swap;
  }
  return head;
}

/**
 * Which finished prefixes get their games counted, out of the `cap` the search can afford. Under a
 * window that names a band the beam's own ranking is the right filter — those branches are already
 * aimed at it. Under an open window the counted leaves are dealt across the rarity range instead, so
 * the same number of intersections measures mixes that land in different bands.
 */
function pickLeaves(level, cap, spread) {
  return spread ? spreadByBound(level, cap) : level.slice(0, cap);
}

/**
 * Keep `cap` of a ranked list across the whole range of pair rarity rather than down one end of it.
 * A branch's **rarest pair** is an admissible upper bound on the count of anything below it, so a
 * decade of that bound is a promise about which bands the mixes under it can still land in. Two
 * buckets per decade, each filled from the list's own order, and the remainder given back to the
 * best-ranked branches — a decade that holds nothing spends its budget on the decades that do.
 */
function spreadByBound(list, cap) {
  if (list.length <= cap) return list.slice(0, cap);
  // The decade of a branch's rarest pair, remembered on the branch: this walks lists of hundreds of
  // thousands of prefixes more than once, and re-doing `Math.log10` per pass is a measurable cost.
  const slotOf = (beam) => {
    if (beam._slot === undefined) {
      const bound = Number.isFinite(beam.bound) ? beam.bound : 1e9;
      // Two buckets per decade of pair count, so `1-2`, `3-9`, `10-31`, `32-99` … are separate asks.
      beam._slot = Math.min(15, Math.floor(Math.log10(1 + bound) * 2));
    }
    return beam._slot;
  };
  const seen = new Uint8Array(16);
  let decades = 0;
  for (const beam of list) {
    const slot = slotOf(beam);
    if (!seen[slot]) { seen[slot] = 1; decades++; }
  }
  const each = Math.max(1, Math.floor(cap / decades));
  const filled = new Int32Array(16);
  const picked = [];
  for (const beam of list) {
    if (picked.length >= cap) break;
    const slot = slotOf(beam);
    if (filled[slot] >= each) continue;
    filled[slot]++;
    picked.push(beam);
  }
  // A decade that holds few prefixes must not leave the budget unused: the remainder goes to the
  // best-ranked prefixes the spread pass did not reach, in the beam's own order.
  if (picked.length < cap) {
    const taken = new Set(picked);
    for (const beam of list) {
      if (picked.length >= cap) break;
      if (!taken.has(beam)) picked.push(beam);
    }
  }
  return picked;
}

/** Does this card still fit the tag cap? Accepting it records its tags in the shared tally. Tags the
 *  search was pinned to do not count: they are on every card of that board by definition. */
function takeCard(space, reuseCap, pinned, used) {
  const chosen = pinned ? space._idxs.filter((t) => !pinned.has(t)) : space._idxs;
  if (chosen.some((t) => (used.get(t) || 0) >= reuseCap)) return false;
  for (const t of chosen) used.set(t, (used.get(t) || 0) + 1);
  return true;
}

/** Take the best spaces without letting a single tag dominate, and without a board that is all blank. Tags the search was pinned to are not counted: they are on every card by definition. The tally is shared by every fill pass, so a cap holds for the whole board and not just for one pass. */
function pickDiverse(candidates, limit, blankQuota, reuseCap, pinned, used = new Map()) {
  const picked = [];
  let blanks = 0;
  for (const space of candidates) {
    if (picked.length >= limit) break;
    const isBlank = space.count === 0;
    if (isBlank && blanks >= blankQuota) continue;
    if (!takeCard(space, reuseCap, pinned, used)) continue;
    if (isBlank) blanks++;
    picked.push(space);
  }
  return picked;
}

/**
 * Deal a board band by band instead of straight down the ranking, so a press whose window is open
 * answers with thin *and* crowded mixes: a `Very common` mix is a fact about the catalog exactly as a
 * gap is, and a board that only ever shows the bottom of the range teaches one thing per press.
 *
 * The share is equal across the bands this search actually found, in rarity order, with two
 * exceptions that are not equal by design: the gap band keeps the modest quota the search was given
 * (a gap is worth showing, but a board of gaps is not), and a band that holds fewer cards than its
 * share simply deals what it has — the fill passes afterwards hand the room to whoever has more.
 * Dealing *round robin* rather than band by band is what keeps the balance inside a single page
 * rather than only inside the whole board: the reader sees the spread on page 1, not by page 4.
 *
 * Returns nothing when there is nothing to spread — a window inside one band, or the gap sweep,
 * which is one band by definition — and the caller takes the ranking's own order instead.
 */
const BAND_ORDER = TIERS.map((t) => t.id);

function pickSpreadBoard(candidates, want, blankQuota, reuseCap, pinned, used) {
  const byBand = new Map();
  for (const space of candidates) {
    const list = byBand.get(space.tier.id);
    if (list) list.push(space);
    else byBand.set(space.tier.id, [space]);
  }
  const bands = BAND_ORDER.filter((id) => byBand.has(id));
  if (bands.length < 3) return [];
  const busy = bands.filter((id) => id !== 'empty');
  if (!busy.length) return [];
  const share = new Map();
  let budget = want;
  if (byBand.has('empty')) {
    const blanks = Math.min(blankQuota, byBand.get('empty').length);
    share.set('empty', blanks);
    budget -= blanks;
  }
  for (const id of busy) share.set(id, Math.max(1, Math.floor(budget / busy.length)));

  const cursor = new Map(bands.map((id) => [id, 0]));
  const dealt = new Map(bands.map((id) => [id, 0]));
  let blanks = 0;
  const picked = [];
  let canDeal = true;
  while (picked.length < want && canDeal) {
    canDeal = false;
    for (const id of bands) {
      if (picked.length >= want || dealt.get(id) >= share.get(id)) continue;
      const list = byBand.get(id);
      let at = cursor.get(id);
      while (at < list.length) {
        const space = list[at++];
        if (space.count === 0 && blanks >= blankQuota) continue;
        if (!takeCard(space, reuseCap, pinned, used)) continue;
        if (space.count === 0) blanks++;
        cursor.set(id, at);
        dealt.set(id, dealt.get(id) + 1);
        picked.push(space);
        canDeal = true;
        break;
      }
      cursor.set(id, at);
    }
  }
  return picked;
}

/** Sub-combinations of a blank space, with counts: the evidence it *almost* exists. */
function emptyNeighbors(tagIdxs) {
  const out = [];
  for (const drop of tagIdxs) {
    const rest = tagIdxs.filter((t) => t !== drop);
    const games = gamesWithAll(rest);
    out.push({
      tags: rest.map((i) => tagView(i)),
      count: games.length,
      avg_demand: Math.round(meanDemandOf(games)),
      tier: tierForCount(games.length).id,
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

function emptyNeighborDemand(tagIdxs) {
  const neighbours = emptyNeighbors(tagIdxs);
  return neighbours.length ? neighbours[0].avg_demand : 0;
}

/* ------------------------------ random draw ------------------------------ */

/**
 * The crates differ only in the pool they draw from, and the blurb is the second line of the
 * crate block the Random draw panel shows — so it has to say the whole difference in one line.
 */
export const CASES = [
  { id: 'wildcard', name: 'Wildcard Crate', blurb: 'Any tag in the catalog.', seeds: [], art: 'wildcard' },
  { id: 'indie', name: 'Indie Crate', blurb: 'Leans toward Indie, Atmospheric and Singleplayer.', seeds: ['Indie', 'Atmospheric', 'Singleplayer'], art: 'indie' },
  { id: 'cozy', name: 'Relaxing Crate', blurb: 'Leans toward Relaxing, Cute and Casual.', seeds: ['Relaxing', 'Cute', 'Casual'], art: 'cozy' },
  { id: 'nightmare', name: 'Horror Crate', blurb: 'Leans toward Horror, Survival and Co-op.', seeds: ['Horror', 'Survival', 'Co-op'], art: 'nightmare' },
  { id: 'loop', name: 'Deep Systems Crate', blurb: 'Leans toward Strategy, Rogue-like and Difficult.', seeds: ['Strategy', 'Rogue-like', 'Difficult'], art: 'loop' },
  { id: 'crowd', name: 'Large Audience Crate', blurb: 'Leans toward Multiplayer, Free to Play and Action.', seeds: ['Multiplayer', 'Free to Play', 'Action'], art: 'crowd' },
  { id: 'toolkit', name: 'Game Making Crate', blurb: 'Leans toward Moddable, Level Editor and Programming.', seeds: ['Moddable', 'Level Editor', 'Programming'], art: 'toolkit' },
];

const caseCache = new Map();

function seedIndexes(c) {
  return c.seeds
    .map((name) => store.tagName.findIndex((n) => n.toLowerCase() === name.toLowerCase()))
    .filter((i) => i >= 0);
}

function caseTagPool(c) {
  if (caseCache.has(c.id)) return caseCache.get(c.id);
  const seeds = seedIndexes(c);
  let pool;
  if (!seeds.length) {
    pool = [];
    for (let t = 0; t < store.nTags; t++) if (!isHiddenTag(t)) pool.push(t);
  } else {
    const seen = new Set(seeds);
    for (const s of seeds) {
      for (let t = 0; t < store.nTags; t++) {
        if (seen.has(t) || isHiddenTag(t)) continue;
        if (pairCountIdx(s, t) >= 15) seen.add(t);
      }
    }
    pool = [...seen];
  }
  caseCache.set(c.id, pool);
  return pool;
}

export function caseView(c) {
  return {
    id: c.id,
    name: c.name,
    blurb: c.blurb,
    art: c.art,
    seeds: seedIndexes(c).map((i) => tagView(i)),
    pool_size: caseTagPool(c).length,
  };
}

export function listCases() {
  return CASES.map(caseView);
}

/**
 * What a draw may say about where it was *aimed*.
 *
 * Only a band the reader named is something they aimed at. Under *Any rarity* and the two
 * *Prioritize* leans the engine picks a target band itself — that is how a roll gets tilted — and
 * echoing that internal pick back as the reader's aim produced sentences like "You aimed at Very
 * rare. This draw landed on Rare." from a reader who never chose Very rare and never could have. So
 * the aim travels in the payload **only** for a named band, and `aim_moved` says when even that band
 * had to be swapped for the closest one the pool or the mix length can hold.
 */
function aimFields(forcedTier, landedTierId, aimMoved = false) {
  const chosen = forcedTier ? TIERS.find((t) => t.id === forcedTier) : null;
  if (!chosen) return { target_tier: null, landed_other_tier: false, aim_moved: Boolean(aimMoved) };
  return {
    target_tier: { id: chosen.id, name: chosen.name, color: chosen.color },
    landed_other_tier: chosen.id !== landedTierId,
    aim_moved: Boolean(aimMoved),
  };
}

const RARITY_BIAS = { balanced: 1, seeker: 3.4, magnet: 0.28 };

/**
 * The three unaimed Rarity options mean the same thing wherever they are used: a range of
 * counts. *Any rarity* is 0 and up, *Prioritize rare* is 0 to 99 games, *Prioritize common*
 * is 100 and up. The Finder filters its search to that window, and a crate or a draft rolls
 * inside the very same window - so the rarity block lights the same rows in all three panels,
 * an option never promises a band it cannot hand out, and a press never answers out of range.
 * A *Guarantee <band>* option is the same idea with a window of one band.
 */
const RARE_HALF_TOP = 'rare';

function rollBands(bias) {
  const top = TIERS.findIndex((t) => t.id === RARE_HALF_TOP);
  if (bias === 'seeker') return TIERS.slice(0, top + 1);
  if (bias === 'magnet') return TIERS.slice(top + 1);
  return TIERS;
}

/** The count window an unaimed option stands for, as the bounds a search takes. */
function rollRange(bias) {
  const bands = rollBands(bias);
  const top = bands[bands.length - 1].max;
  return { minCount: bands[0].min, maxCount: top === Infinity ? 1_000_000 : top };
}

const inRange = (bias, tierId) => rollBands(bias).some((t) => t.id === tierId);

function rollWeights(bands, bias) {
  const factor = RARITY_BIAS[bias] ?? 1;
  return bands.map((t) => ({
    tier: t,
    // The gap band keeps its own weight instead of being pulled by the bias: its weight is not
    // one rung of the log ladder getting likelier, it is the option agreeing to include nothing
    // at all, and the bias would multiply a number that was chosen for the share it should have.
    w: Math.max(0.05, t.weight * (t.id === 'empty' ? 1 : t.min <= 100 ? factor : 1 / factor)),
  }));
}

function pickWeightedTier(bias) {
  const weights = rollWeights(rollBands(bias), bias);
  const total = weights.reduce((s, x) => s + x.w, 0);
  let roll = Math.random() * total;
  for (const x of weights) {
    roll -= x.w;
    if (roll <= 0) return x.tier;
  }
  return weights[weights.length - 1].tier;
}

/**
 * The bands a failed aim falls back to, nearest first and never outside what the option
 * covers: a *Prioritize rare* press that cannot find a Very rare mix goes rarer or busier
 * inside 0-99, it does not drift into the common half it said it would skip.
 */
function fallbackBands(bias, target) {
  const bands = rollBands(bias);
  const at = bands.findIndex((t) => t.id === target.id);
  const before = bands.slice(0, at === -1 ? 0 : at).reverse();
  const after = bands.slice(at + 1);
  return [...before, ...after];
}

/**
 * Aim inside a draft pool. A pool of a dozen tags cannot hold the busy bands a
 * crate can, so the aim is taken from the bands this pool actually holds: each
 * band gets a share of the combinations it still has that this draw has not just
 * handed out, opened up by the square root so the biggest band does not swallow
 * the draw, then tilted by the same rarity bias a crate draw uses. A band whose
 * combinations were all drawn in the last presses has nothing left to give and is
 * not aimed at.
 */
function pickHeldTier(bands, bias, freshOf = (band) => band.count) {
  const factor = RARITY_BIAS[bias] ?? 1;
  // The same window the option means everywhere else: a draft under *Prioritize common* does
  // not hand out a gap any more than the Finder would return one.
  const covered = bands.filter((band) => inRange(bias, band.id));
  const weights = (covered.length ? covered : bands).map((band) => {
    const tier = TIERS.find((t) => t.id === band.id) || TIERS[TIERS.length - 1];
    // Inside a small pool an empty combination is a gap between tags that are each used by a
    // lot of games, so it is aimed at by weight like any other band - its share of a press is
    // what `tiers.js` chose for it, and the pool decides whether it can be reached at all.
    const share = Math.sqrt(Math.max(1, freshOf(band)));
    return {
      tier,
      w: Math.max(0.05, share * tier.weight * (tier.id === 'empty' ? 1 : tier.min <= 100 ? factor : 1 / factor)),
    };
  });
  const total = weights.reduce((s, x) => s + x.w, 0);
  let roll = Math.random() * total;
  for (const x of weights) {
    roll -= x.w;
    if (roll <= 0) return x.tier;
  }
  return weights[weights.length - 1].tier;
}

function weightedTagPick(pool, popularWeighting) {
  if (!popularWeighting) return pool[(Math.random() * pool.length) | 0];
  let total = 0;
  for (const t of pool) total += Math.sqrt(store.tagCount[t]);
  let roll = Math.random() * total;
  for (const t of pool) {
    roll -= Math.sqrt(store.tagCount[t]);
    if (roll <= 0) return t;
  }
  return pool[pool.length - 1];
}

/**
 * Draw a random tag combination aimed at a target rarity tier.
 * Popular tiers come out of plain sampling; rare tiers are hunted with the
 * band scanner, which stays exact and fast. If a band is empty the draw lands
 * on the next tier down rather than failing.
 */
/**
 * One crate press. Everything in here is `Math.random()` on purpose: no seed reaches the
 * combination a press lands on, because that is the part the human came here to be
 * surprised by. The seeded paths are the scan's ranking and the draft pool.
 */
export function drawCombo({ k = 3, caseId = 'wildcard', bias = 'balanced', forcedTier = null, avoid = [] } = {}) {
  const avoidKeys = new Set();
  for (const raw of avoid) {
    const ids = String(raw).split(/[|,]/).map((x) => Number(x)).filter(Number.isFinite);
    const idxs = ids.map((id) => store.tagIndexOf.get(id)).filter((i) => i !== undefined);
    if (idxs.length) avoidKeys.add(comboKey(idxs));
  }
  const theCase = CASES.find((c) => c.id === caseId) || CASES[0];
  const pool = caseTagPool(theCase);
  const seeds = seedIndexes(theCase);
  let target = (forcedTier && TIERS.find((t) => t.id === forcedTier)) || pickWeightedTier(bias);
  // "Guarantee Common" on a five-tag mix is a promise this catalog cannot keep - no
  // five tags are that popular together. Aim at the closest band that does exist at
  // this length instead of dressing up a near miss as a hit.
  const emptyBands = new Set(bandAvailability(k));
  let aimMoved = false;
  if (forcedTier && emptyBands.has(target.id)) {
    const pos = TIERS.findIndex((t) => t.id === target.id);
    for (let i = pos - 1; i >= 1; i--) {
      if (!emptyBands.has(TIERS[i].id)) {
        target = TIERS[i];
        aimMoved = true;
        break;
      }
    }
  }

  // What this press may hand out: the one band a guarantee names, or every band the option
  // covers - which is the same range the Finder would have searched.
  const allowed = forcedTier ? [target] : rollBands(bias);
  const allowedIds = new Set(allowed.map((t) => t.id));
  const window = rollRange(bias);

  let attempts = 0;
  // A crate press should feel instant. Beyond this budget we stop hunting the
  // exact band and let the cheap band sampler (or the rescue pass) decide.
  const deadline = Date.now() + (forcedTier ? 1500 : 900);
  // Bands to fall back to when the aim turns up nothing: a guarantee slides to its neighbours,
  // an unaimed press slides inside its own range (`fallbackBands`), never out of it.
  const chase = forcedTier ? [target, ...neighbourTiers(target)] : [target, ...fallbackBands(bias, target)];
  for (const tier of chase) {
    const tierMax = tier.max === Infinity ? 1e9 : tier.max;
    const isGap = tier.max === 0;
    // Tags rarer than the band are fine for a pair or a trio; a four- or five-tag
    // mix needs tags that are individually much busier than the band it lands in.
    const tierPoolCap = tier.max === Infinity || k >= 4 ? 0 : Math.max(500, tier.max * 8);
    // Inside the range this press chose, and never below or above it.
    const lo = forcedTier ? tier.min : Math.max(tier.min, window.minCount);
    const hi = Math.min(tierMax, forcedTier ? 60000 : Math.min(window.maxCount, 60000));
    let found = null;

    attempts++;
    found = isGap ? sampleGapCombo(k, pool, seeds, avoidKeys) : sampleBandCombo(k, tier, pool, seeds, avoidKeys);

    // A long forced band is almost never built out of pairs that are rare too.
    // Let the pairs be busy, as long as the mix itself lands in the band.
    if (!found && forcedTier && tier === target && !isGap) {
      found = sampleBandCombo(k, tier, pool, seeds, avoidKeys, 1);
    }

    // Last honest shot at the band: start from a pair that is already in it and
    // grow, so the exact count cannot drift out of the band on the way.
    if (!found && !isGap) {
      found = growBandCombo(k, tier, pool, seeds, avoidKeys, Math.max(60, deadline - Date.now()));
    }

    if (!found && !isGap && hi > lo && Date.now() < deadline) {
      const scan = scanSpaces({
        k,
        minCount: lo,
        maxCount: hi,
        includeEmpty: false,
        rankBy: tier.min >= 2500 ? 'audience' : 'potential',
        limit: 40,
        poolCap: tierPoolCap,
        thoroughness: 2,
        deadlineMs: Math.max(80, deadline - Date.now()),
        maxTagReuse: 2,
        seed: (Math.random() * 1e9) | 0,
        mustTags: seeds.length && Math.random() < 0.5 ? [seeds[(Math.random() * seeds.length) | 0]] : [],
        gamesPerSpace: 3,
      });
      const options = scan.spaces.filter(
        (s) => s.count >= tier.min && s.count <= tierMax && !avoidKeys.has(comboKey(s.tags.map((t) => store.tagIndexOf.get(t.id)))),
      );
      if (options.length) {
        const pick = options[(Math.random() * options.length) | 0];
        found = { tags: pick.tags.map((t) => store.tagIndexOf.get(t.id)), count: pick.count };
      }
    }

    // A forced band gets one more sweep ranked by audience before we slide down.
    if (!found && forcedTier && tier === target && !isGap && Date.now() < deadline) {
      const again = scanSpaces({
        k,
        minCount: lo,
        maxCount: hi,
        includeEmpty: false,
        rankBy: 'audience',
        limit: 30,
        thoroughness: 3,
        poolCap: tierPoolCap,
        deadlineMs: Math.max(80, deadline - Date.now()),
        maxTagReuse: 1,
        seed: (Math.random() * 1e9) | 0,
        gamesPerSpace: 3,
      });
      const options = again.spaces.filter(
        (s) => s.count >= tier.min && s.count <= tierMax && !avoidKeys.has(comboKey(s.tags.map((t) => store.tagIndexOf.get(t.id)))),
      );
      if (options.length) {
        const pick = options[(Math.random() * options.length) | 0];
        found = { tags: pick.tags.map((t) => store.tagIndexOf.get(t.id)), count: pick.count };
      }
    }

    if (!found) continue;

    const summary = comboSummary(found.tags, { limit: 5 });
    const ladder = found.tags.map((drop) => {
      const rest = found.tags.filter((t) => t !== drop);
      const c = gamesWithAll(rest).length;
      const tr = tierForCount(c);
      return { tags: rest.map((i) => tagView(i)), count: c, tier: { id: tr.id, name: tr.name, color: tr.color } };
    });
    return {
      case: caseView(theCase),
      combo: summary,
      ladder,
      ...aimFields(forcedTier, summary.tier.id, aimMoved),
      attempts,
      reel: buildReel(found.tags, pool),
    };
  }

  // Still nothing? Try the rest of the bands this press may hand out, busiest first, with
  // busy pairs allowed: a long mix can be rare even when every pair is common.
  for (const band of allowed.filter((b) => b.id !== target.id).sort((a, b) => b.min - a.min)) {
    const rescue = band.max === 0
      ? sampleGapCombo(k, pool, [], avoidKeys)
      : growBandCombo(k, band, pool, [], avoidKeys, 500)
        || sampleBandCombo(k, band, pool, [], avoidKeys, 1);
    if (!rescue) continue;
    const tags = rescue.tags;
    const summary = comboSummary(tags, { limit: 5 });
    return {
      case: caseView(theCase),
      combo: summary,
      ladder: summary.variants || [],
      ...aimFields(forcedTier, summary.tier.id, aimMoved),
      attempts,
      reel: buildReel(tags, pool),
    };
  }

  // Last resort: any honest random mix, whatever rarity it happens to be. Even here the
  // option's range is tried for first, because a *Prioritize* option said what it covers.
  const looseOf = () => {
    const set = new Set();
    if (seeds.length) set.add(seeds[0]);
    let guard = 0;
    while (set.size < k && guard++ < 200) set.add(weightedTagPick(pool, false));
    return set.size < k ? null : [...set].sort((a, b) => a - b);
  };
  let tags = null;
  for (let tryLoose = 0; tryLoose < 8; tryLoose++) {
    const mix = looseOf();
    if (!mix) break;
    const band = tierForCount(gamesWithAll(mix).length);
    if (forcedTier || allowedIds.has(band.id) || tryLoose === 7) {
      tags = mix;
      break;
    }
  }
  if (!tags) return null;
  const summary = comboSummary(tags, { limit: 5 });
  return {
    case: caseView(theCase),
    combo: summary,
    ladder: summary.variants || [],
    ...aimFields(forcedTier, summary.tier.id),
    attempts,
    reel: buildReel(tags, pool),
  };
}

/**
 * A gap made out of this pool's own tags: k tags no catalogued game carries together. One
 * pair that no game carries settles it on its own - nothing can hold all k if it cannot hold
 * two - so each tag is only accepted when it shares no games with what is already picked, and
 * the exact intersection is checked once at the end.
 */
function sampleGapCombo(k, pool, seeds, avoidKeys) {
  const CANDS = 40;
  for (let attempt = 0; attempt < 28; attempt++) {
    const tags = seeds && seeds.length && Math.random() < 0.7 ? [seeds[(Math.random() * seeds.length) | 0]] : [];
    let stuck = false;
    while (tags.length < k) {
      const cands = [];
      let fitting = 0;
      for (const t of pool) {
        if (tags.includes(t)) continue;
        let shares = false;
        for (const x of tags) {
          if (pairCountIdx(x, t) > 0) { shares = true; break; }
        }
        if (shares) continue;
        fitting++;
        if (cands.length < CANDS) {
          cands.push(t);
        } else {
          const at = (Math.random() * fitting) | 0;
          if (at < CANDS) cands[at] = t;
        }
      }
      if (!cands.length) { stuck = true; break; }
      tags.push(cands[(Math.random() * cands.length) | 0]);
    }
    if (stuck) continue;
    const sorted = [...tags].sort((a, b) => a - b);
    if (avoidKeys && avoidKeys.has(comboKey(sorted))) continue;
    if (gamesWithAll(sorted).length === 0) return { tags: sorted, count: 0 };
  }
  return null;
}

/**
 * Land inside a rarity band without scanning the whole space: every pair that
 * gets added must already sit inside the band, so the exact count lands there
 * too most of the time. Pair counts are exact lookups, so this is cheap. Pass a
 * lower pair floor when the mix should be rare even though its pairs are not.
 */
function sampleBandCombo(k, tier, pool, seeds, avoidKeys, pairFloorMin = tier.min) {
  const tierMax = tier.max === Infinity ? 1e9 : tier.max;
  const pairFloor = Math.max(1, pairFloorMin);
  const CANDS = 40;
  for (let attempt = 0; attempt < 28; attempt++) {
    const tags = seeds && seeds.length && Math.random() < 0.7 ? [seeds[(Math.random() * seeds.length) | 0]] : [];
    let stuck = false;
    while (tags.length < k) {
      // The pool is ordered busiest tag first. Taking the first 40 tags that fit
      // would keep the same popular handful in play on every press, so the fitting
      // tags are held in a fixed set of slots that later tags replace by chance.
      const cands = [];
      let fitting = 0;
      for (const t of pool) {
        if (tags.includes(t)) continue;
        let fits = true;
        for (const x of tags) {
          const pc = pairCountIdx(x, t);
          if (pc > tierMax || pc < pairFloor) {
            fits = false;
            break;
          }
        }
        if (!fits) continue;
        fitting++;
        if (cands.length < CANDS) {
          cands.push(t);
        } else {
          const at = (Math.random() * fitting) | 0;
          if (at < CANDS) cands[at] = t;
        }
      }
      if (!cands.length) {
        stuck = true;
        break;
      }
      tags.push(cands[(Math.random() * cands.length) | 0]);
    }
    if (stuck) continue;
    const sorted = [...tags].sort((a, b) => a - b);
    if (avoidKeys && avoidKeys.has(comboKey(sorted))) continue;
    const count = gamesWithAll(sorted).length;
    if (count >= tier.min && count <= tierMax) return { tags: sorted, count };
  }
  return null;
}

/**
 * Tags seen inside a set of games, spread from the most common to the rarest so a
 * growth step can pick a tag that narrows the set gently or sharply. The list is
 * app ids, and each game's tag layout is keyed by row, so every lookup converts.
 */
function cooccurCandidates(appIds, banned, limit) {
  const freq = new Map();
  const sample = Math.min(appIds.length, 40);
  for (let s = 0; s < sample; s++) {
    const r = store.rowOfApp.get(appIds[(Math.random() * appIds.length) | 0]);
    if (r === undefined) continue;
    for (const t of tagsOfRow(r)) {
      if (banned.has(t) || isHiddenTag(t)) continue;
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  const all = [...freq.keys()].sort(
    (x, y) => (freq.get(y) - freq.get(x)) || store.tagCount[y] - store.tagCount[x],
  );
  if (all.length <= limit) return all;
  const stride = all.length / limit;
  const out = [];
  for (let i = 0; i < limit; i++) out.push(all[Math.floor(i * stride)]);
  return out;
}

/**
 * Grow a mix that lands inside a rarity band. Start from a pair at or above the
 * band and add tags one at a time: an intersection can only shrink a count, so
 * keeping every step at or above the band floor guarantees the floor, and the
 * last tag is chosen to drop the count into the band. Tags come from the games
 * already in the mix, so the extras are thematic rather than filler. Exact
 * counts throughout, no guessing and hoping.
 */
export function growBandCombo(k, tier, pool, seeds, avoidKeys, budgetMs) {
  const tierMax = tier.max === Infinity ? 1e9 : tier.max;
  if (k < 2 || tierMax === 0) return null; // the Empty band has its own path
  const stop = Date.now() + Math.max(40, budgetMs);

  const counts = store.pairCounts;
  const keys = store.pairKeys;
  // A pair mix is the band itself. A longer mix needs room above the band to
  // shrink into, because each tag added cuts the crowd again - roughly tenfold.
  // A five-tag Rare mix is usually made of pairs four orders busier than 99.
  const headroom = Math.pow(6, Math.max(0, k - 2));
  const anchorMax =
    k === 2
      ? tierMax
      : tierMax === 1e9
        ? tier.min * 3 * headroom
        : Math.min(tierMax * 4 * headroom, 80000);
  const lo = lowerBoundValue(counts, Math.max(1, tier.min));
  const hi = lowerBoundValue(counts, anchorMax + 1);
  if (hi <= lo) return null;
  // The sweet spot for a prefix of a given length: busy enough that the tags
  // still to come can pull it into the band, rare enough that it will not stall
  // above the band with no slots left.
  const room = (length) =>
    tierMax === 1e9
      ? tier.min * 3
      : Math.max(tier.min, tierMax * Math.pow(6, Math.max(0, k - length)));
  const midOf = (length) => Math.sqrt(Math.max(1, tier.min) * room(length));
  // Merging a very busy posting is the one expensive move in here, so the cap
  // follows the same headroom logic instead of freezing long mixes out.
  const postingCeil = tierMax === 1e9 ? Infinity : Math.max(3000, room(2) * 4);
  let outOfTime = false;

  for (let attempt = 0; attempt < 30; attempt++) {
    if (Date.now() > stop) {
      outOfTime = true;
      break;
    }
    const p = lo + ((Math.random() * (hi - lo)) | 0);
    const [a, b] = pairParts(keys[p]);
    if (isHiddenTag(a) || isHiddenTag(b)) continue;

    let tags = [a, b];
    let rows = intersect(store.postings[a], store.postings[b]);
    if (rows.length < tier.min) continue;
    if (k === 2) {
      if (rows.length > tierMax) continue;
      if (!avoidKeys || !avoidKeys.has(comboKey(tags))) return { tags, count: rows.length };
      continue;
    }

    // Case flavour, but only if it does not push the mix under the band floor.
    if (seeds && seeds.length && Math.random() < 0.6) {
      const seed = seeds[(Math.random() * seeds.length) | 0];
      if (!tags.includes(seed) && !isHiddenTag(seed)) {
        const next = intersect(rows, store.postings[seed]);
        if (next.length >= tier.min) {
          tags.push(seed);
          rows = next;
        }
      }
    }

    while (tags.length < k && rows.length >= tier.min) {
      if (Date.now() > stop) {
        outOfTime = true;
        break;
      }
      const last = tags.length === k - 1;
      const used = new Set(tags);
      const cands = cooccurCandidates(rows, used, 18);
      for (let s = 0; s < 6 && cands.length < 22; s++) {
        const t = pool[(Math.random() * pool.length) | 0];
        if (!used.has(t) && !isHiddenTag(t) && !cands.includes(t)) cands.push(t);
      }
      let best = null;
      let probes = 0;
      for (const t of cands) {
        if (++probes % 8 === 0 && Date.now() > stop) {
          outOfTime = true;
          break;
        }
        if (store.tagCount[t] > postingCeil) continue;
        // A mix is never more common than its rarest pair, which is a cheap way to
        // throw out candidates that cannot keep it above the band floor.
        let hopeless = false;
        for (const x of tags) {
          if (pairCountIdx(x, t) < tier.min) {
            hopeless = true;
            break;
          }
        }
        if (hopeless) continue;
        const next = intersect(rows, store.postings[t]);
        if (next.length < tier.min) continue;
        if (last && next.length > tierMax) continue;
        // Steer every prefix towards the window it needs to sit in: busy enough
        // that the tags still missing can cut it down, rare enough to arrive.
        const target = midOf(tags.length + 1);
        const score = -Math.abs(Math.log10((next.length + 1) / (target + 1)));
        const jittered = score + Math.random() * 0.08;
        if (!best || jittered > best.score) best = { t, rows: next, score: jittered };
      }
      if (outOfTime || !best) break;
      tags.push(best.t);
      rows = best.rows;
    }

    if (outOfTime) break;
    if (tags.length !== k) continue;
    const sorted = tags.sort((x, y) => x - y);
    if (avoidKeys && avoidKeys.has(comboKey(sorted))) continue;
    const count = rows.length;
    if (count >= tier.min && count <= tierMax) return { tags: sorted, count };
  }
  return null;
}

/** Binary search for the first index whose value is >= v (ascending Int32Array). */
function lowerBoundValue(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The target band first, then the neighbouring (more common) bands. */
function neighbourTiers(tier) {
  const pos = TIERS.findIndex((t) => t.id === tier.id);
  return TIERS.slice(pos + 1, pos + 3);
}

/* ----------------------------- band availability ----------------------------- */

let reachMemo = null;

/**
 * Can a mix of `k` tags be as busy as the top band? The busy end of the catalog
 * is the first thing a long mix runs out of: a five-tag mix needs tags that are
 * individually enormous, and no five share ten thousand games. Only tags big
 * enough to host such a mix are searched, pruned by the pair bound, so a "no"
 * here is a fact about the catalog and not the sampler giving up.
 */
function topBandReachable(k) {
  const floor = TIERS[TIERS.length - 1].min;
  const busy = [];
  for (let i = 0; i < store.nTags; i++) {
    if (store.tagCount[i] >= floor && !isHiddenTag(i)) busy.push(i);
  }
  if (k === 2) {
    for (let a = 0; a < busy.length; a++) {
      for (let b = a + 1; b < busy.length; b++) {
        if (pairCountIdx(busy[a], busy[b]) >= floor) return true;
      }
    }
    return false;
  }
  const walk = (from, chosen, bound, rows) => {
    if (chosen.length === k) return true;
    for (let i = from; i < busy.length; i++) {
      const t = busy[i];
      let nextBound = bound;
      let hopeless = false;
      for (const x of chosen) {
        const pc = pairCountIdx(x, t);
        if (pc < nextBound) nextBound = pc;
        if (nextBound < floor) {
          hopeless = true;
          break;
        }
      }
      if (hopeless) continue;
      const next = chosen.length ? intersect(rows, store.postings[t]) : store.postings[t];
      if (next.length < floor) continue;
      if (walk(i + 1, [...chosen, t], nextBound, next)) return true;
    }
    return false;
  };
  return walk(0, [], Infinity, new Int32Array(0));
}

/**
 * Bands a `k`-tag mix cannot land in. The top band is the only one worth asking
 * about: every band below it has been filled by the sampler at every length this
 * app offers.
 */
export function bandAvailability(k) {
  const length = Math.max(2, Math.min(5, Number(k) || 3));
  reachMemo ??= new Map();
  let reachable = reachMemo.get(length);
  if (reachable === undefined) {
    reachable = topBandReachable(length);
    reachMemo.set(length, reachable);
  }
  return reachable ? [] : [TIERS[TIERS.length - 1].id];
}

/** Reel strip: filler tags, then the winning tags in the landing slots. */
function buildReel(winning, pool) {
  const winSet = new Set(winning);
  const used = new Set(winSet);
  const fillers = [];
  for (let guard = 0; fillers.length < 31 && guard < 900; guard++) {
    const t = pool[(Math.random() * pool.length) | 0];
    if (used.has(t)) continue;
    used.add(t);
    fillers.push(t);
  }
  while (fillers.length < 31) fillers.push(pool[(fillers.length * 7) % pool.length]);
  const winList = [...winning].sort(() => Math.random() - 0.5);
  const strip = [...fillers, ...winList].map((t, i) => ({
    slot: i,
    tag: tagView(t),
    winning: i >= fillers.length,
  }));
  return { strip, win_at: fillers.length, length: strip.length };
}

/* ------------------------------- draft pick ------------------------------- */

/**
 * Draft pick: the app shows a pool of tags, the user disables some of them, and
 * the draw is limited to the tags left in the pool. A pool this small can be
 * counted in full, so the band census, the drawn mix and the answer to "that
 * band cannot happen in this pool" all come out of the same exact walk.
 */

/** How many mixes of `k` tags can be made out of `n` tags. Exact at these sizes. */
function chooseCount(n, k) {
  if (k < 0 || n < k) return 0;
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return Math.round(out);
}

/**
 * The tags one draft shows: `k` tags taken out of one catalogued game, which
 * share that game, so the pool always starts with a combination that has games;
 * and the rest taken by striding over the case pool ordered by how many games
 * use each tag, so the tags shown cover the busy end and the rare end of the
 * pool instead of one block of neighbours. Seeded, so the same seed shows the
 * same tags: the draw re-derives the pool instead of trusting the browser.
 */
function draftShownTags({ caseId = 'wildcard', shown = 16, k = 3, seed = 0 } = {}) {
  const theCase = CASES.find((c) => c.id === caseId) || CASES[0];
  const wanted = Math.max(2, Math.min(shown, 20));
  const size = Math.max(2, Math.min(5, k));
  const cacheKey = `draft:shown:${theCase.id}:${wanted}:${size}:${seed >>> 0}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const pool = caseTagPool(theCase).filter((t) => !isHiddenTag(t));
  if (!pool.length) return [];
  const rng = seedStream((seed >>> 0) || 1);
  const chosen = new Set();

  // A game that carries many tags from the pool gives the strongest group.
  const inPool = new Set(pool);
  const anchor = pool[(rng() * pool.length) | 0];
  const rows = store.postings[anchor];
  let group = [];
  for (let s = 0; rows.length && s < 8; s++) {
    const r = rows[(rng() * rows.length) | 0];
    const tags = [...tagsOfRow(r)].filter((t) => !isHiddenTag(t) && inPool.has(t));
    if (tags.length > group.length) group = tags;
    if (group.length >= size) break;
  }
  // A game's tags are listed busiest first, so taking the first ones would put the
  // same popular tags in nearly every pool. The tags kept from this game are chosen
  // by chance.
  const take = group.slice();
  for (let i = take.length - 1; i > 0; i--) {
    const at = (rng() * (i + 1)) | 0;
    const swap = take[i];
    take[i] = take[at];
    take[at] = swap;
  }
  for (const t of take.slice(0, size)) chosen.add(t);

  const spread = pool.slice().sort((a, b) => store.tagCount[b] - store.tagCount[a]);
  const stride = spread.length / wanted;
  for (let s = 0; s < wanted && chosen.size < wanted; s++) {
    // Take one tag from each slice of the popularity range, and move inside the
    // slice by chance, so a new seed shows tags that are neighbours but not the
    // same tags.
    const step = Math.max(1, Math.floor(stride));
    const at = Math.floor(s * stride) + Math.floor(rng() * step);
    chosen.add(spread[Math.min(spread.length - 1, at)]);
  }
  let guard = 0;
  while (chosen.size < wanted && guard++ < 4000) chosen.add(spread[(rng() * spread.length) | 0]);

  const out = [...chosen].sort((a, b) => store.tagCount[b] - store.tagCount[a]);
  cacheSet(cacheKey, out);
  return out;
}

/**
 * Count every mix of `k` tags inside a pool of tags, exactly: how many there
 * are, how many carry games, and how many land in each band. Every prefix
 * carries the real intersection of its tags' posting lists, and a prefix with no
 * games left is finished by counting the mixes it stands for instead of walking
 * them one by one. One mix per band is kept on the side, so a census and a draw
 * cost the same walk. `tags` must be ascending: each mix is reached once.
 */
export function poolCensus(tags, k, { avoidKeys = null } = {}) {
  const n = tags.length;
  const total = chooseCount(n, k);
  if (!total || total > 200_000) return null;

  const bands = new Map();
  const samples = new Map();
  const chosen = new Int32Array(k);
  let withGames = 0;

  const addBand = (tierId, weight, mix) => {
    bands.set(tierId, (bands.get(tierId) || 0) + weight);
    let slot = samples.get(tierId);
    if (!slot) {
      slot = { seen: 0, pick: null, freshSeen: 0, freshPick: null };
      samples.set(tierId, slot);
    }
    if (!mix) return;
    slot.seen += weight;
    if (Math.random() * slot.seen < weight) slot.pick = mix;
    if (avoidKeys && avoidKeys.has(comboKey(mix))) return;
    slot.freshSeen += weight;
    if (Math.random() * slot.freshSeen < weight) slot.freshPick = mix;
  };

  // A random finish for a prefix that already has no games left: any of the tags
  // still to come can stand in for the rest of the mix.
  const finish = (start, slots) => {
    const rest = tags.slice(start);
    const out = [];
    for (let s = 0; s < slots && rest.length; s++) {
      const at = (Math.random() * rest.length) | 0;
      out.push(rest[at]);
      rest[at] = rest[rest.length - 1];
      rest.pop();
    }
    return out;
  };

  const walk = (start, depth, rows) => {
    const slots = k - depth;
    if (slots === 0) {
      const tier = tierForCount(rows.length);
      const mix = Array.from(chosen);
      addBand(tier.id, 1, mix);
      if (rows.length) withGames++;
      return;
    }
    if (depth && !rows.length) {
      const weight = chooseCount(n - start, slots);
      if (!weight) return;
      addBand('empty', weight, [...Array.from(chosen.subarray(0, depth)), ...finish(start, slots)]);
      return;
    }
    for (let i = start; i + slots <= n; i++) {
      const t = tags[i];
      // A pair with no games in common empties the mix, so every mix built on it
      // is Empty too and gets counted in one step.
      let empty = false;
      for (let d = 0; d < depth; d++) {
        if (!pairCountIdx(chosen[d], t)) {
          empty = true;
          break;
        }
      }
      if (empty) {
        const weight = chooseCount(n - i - 1, slots - 1);
        if (weight) {
          const mix = [...Array.from(chosen.subarray(0, depth)), t, ...finish(i + 1, slots - 1)];
          addBand('empty', weight, mix);
        }
        continue;
      }
      chosen[depth] = t;
      walk(i + 1, depth + 1, depth ? intersect(rows, store.postings[t]) : store.postings[t]);
    }
  };
  walk(0, 0, new Int32Array(0));

  return {
    combinations: total,
    combinations_with_games: withGames,
    bands: TIERS.filter((t) => bands.get(t.id)).map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      min: t.min,
      max: t.max === Infinity ? null : t.max,
      count: bands.get(t.id),
    })),
    samples,
  };
}

/** The pool one draft shows, with the bands that exist inside the tags left in it. */
export function draftPoolView({ caseId = 'wildcard', shown = 16, k = 3, seed = 0, disabled = [] } = {}) {
  const theCase = CASES.find((c) => c.id === caseId) || CASES[0];
  const tags = draftShownTags({ caseId: theCase.id, shown, k, seed });
  const banned = new Set(disabled.filter((t) => tags.includes(t)));
  const left = tags.filter((t) => !banned.has(t)).sort((a, b) => a - b);
  if (left.length < k) {
    return { error: `Not enough tags left in the pool: a combination needs ${k} tags.` };
  }
  const census = poolCensus(left, k);
  if (!census) return null;
  return {
    case: caseView(theCase),
    seed: seed >>> 0,
    tags: tags.map((i) => tagView(i)),
    pool: {
      shown: tags.length,
      in_pool: left.length,
      removed: banned.size,
      combinations: census.combinations,
      combinations_with_games: census.combinations_with_games,
      bands: census.bands,
    },
  };
}

/**
 * Draw one mix out of the tags left in the pool. The pool decides what is
 * possible: the aim moves to the closest band this pool can hold, and the answer
 * says that plainly instead of dressing up the move.
 */
export function draftDraw({
  caseId = 'wildcard',
  shown = 16,
  k = 3,
  seed = 0,
  disabled = [],
  bias = 'balanced',
  forcedTier = null,
  avoid = [],
} = {}) {
  const theCase = CASES.find((c) => c.id === caseId) || CASES[0];
  const shownTags = draftShownTags({ caseId: theCase.id, shown, k, seed });
  const banned = new Set(disabled.filter((t) => shownTags.includes(t)));
  const pool = shownTags.filter((t) => !banned.has(t)).sort((a, b) => a - b);
  if (pool.length < k) {
    return { error: `Not enough tags left in the pool: a combination needs ${k} tags.` };
  }

  const avoidKeys = new Set();
  for (const raw of avoid) {
    const ids = String(raw).split(/[|,]/).map((x) => Number(x)).filter(Number.isFinite);
    const idxs = ids.map((id) => store.tagIndexOf.get(id)).filter((i) => i !== undefined);
    if (idxs.length) avoidKeys.add(comboKey(idxs));
  }

  const census = poolCensus(pool, k, { avoidKeys });
  if (!census) return { error: 'Too many tag combinations in this pool to count exactly. Use fewer tags.' };

  const aimed = (forcedTier && TIERS.find((t) => t.id === forcedTier)) || pickWeightedTier(bias);
  const posOf = (tierId) => TIERS.findIndex((t) => t.id === tierId);
  const held = census.bands.filter((band) => census.samples.get(band.id)?.pick);
  if (!held.length) return { error: 'No band in this pool holds a combination.' };

  let target = aimed;
  let aimMoved = false;
  const freshOf = (band) => census.samples.get(band.id)?.freshSeen || 0;
  const freshBands = held.filter((band) => freshOf(band) > 0);
  if (!held.some((band) => band.id === aimed.id)) {
    aimMoved = true;
    if (forcedTier) {
      // A guarantee keeps its promise as closely as the pool allows.
      const from = posOf(aimed.id);
      let closest = null;
      for (const band of held) {
        const gap = Math.abs(posOf(band.id) - from);
        if (!closest || gap < closest.gap) closest = { band, gap };
      }
      target = TIERS[posOf(closest.band.id)];
    } else {
      target = pickHeldTier(freshBands.length ? freshBands : held, bias, freshOf);
    }
  } else if (!forcedTier && freshOf(aimed) === 0) {
    // The band is in the pool, but every combination in it was drawn in the last
    // presses. Bands that still hold one this draw has not seen get the aim.
    target = freshBands.length ? pickHeldTier(freshBands, bias, freshOf) : aimed;
  }

  const slot = census.samples.get(target.id);
  const picked = slot && (slot.freshPick || slot.pick);
  if (!picked) return null;
  const tags = [...picked].sort((a, b) => a - b);

  const summary = comboSummary(tags, { limit: 5 });
  const ladder = tags.map((drop) => {
    const rest = tags.filter((t) => t !== drop);
    const c = gamesWithAll(rest).length;
    const tr = tierForCount(c);
    return { tags: rest.map((i) => tagView(i)), count: c, tier: { id: tr.id, name: tr.name, color: tr.color } };
  });

  return {
    case: caseView(theCase),
    seed: seed >>> 0,
    pool: {
      shown: shownTags.length,
      in_pool: pool.length,
      removed: banned.size,
      combinations: census.combinations,
      combinations_with_games: census.combinations_with_games,
      bands: census.bands,
      tags: pool.map((i) => tagView(i)),
    },
    combo: summary,
    ladder,
    ...aimFields(forcedTier, summary.tier.id, aimMoved),
    reel: buildReel(tags, pool),
  };
}
