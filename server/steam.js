/**
 * Steam storefront helpers.
 *
 * Only Node built-ins: global fetch + AbortController, plain string parsing.
 * Every request carries `?l=english` so tag names stay comparable with the
 * dictionary already stored in the catalog.
 */

import { normalizeKey } from '../public/engine/tags.js';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 SteamTagsExplorer/1.0';

const APP_LIST_URL = 'https://raw.githubusercontent.com/jsnli/steamappidlist/master/data/games_appid.json';
const POPULAR_TAGS_URL = 'https://store.steampowered.com/tagdata/populartags/english';
const STORE_PAGE_URL = (appId) => `https://store.steampowered.com/app/${appId}/?l=english`;
// Storefront pages render review counts through AJAX, so counts come from here.
const REVIEWS_URL = (appId) =>
  `https://store.steampowered.com/appreviews/${appId}?json=1&filter=all&language=all&purchase_type=all&num_per_page=0`;

const DEFAULT_TIMEOUT_MS = 20000;

/* ------------------------------- fetch plumbing ------------------------------- */

async function fetchRaw(url, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, headers = {}, label = url } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          ...headers,
        },
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${label}`);
        err.status = res.status;
        // 429/503 are worth one patient retry; 404 is final.
        if (res.status === 404) throw err;
        lastError = err;
        if (attempt < retries) await sleep(res.status === 429 ? 2500 : 900);
        continue;
      }
      return { status: res.status, text };
    } catch (err) {
      lastError = err.name === 'AbortError' ? new Error(`timeout after ${timeoutMs}ms for ${label}`) : err;
      if (lastError.status === 404) throw lastError;
      if (attempt < retries) await sleep(900);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`request failed for ${label}`);
}

export async function fetchText(url, opts = {}) {
  return (await fetchRaw(url, opts)).text;
}

export async function fetchJson(url, opts = {}) {
  const text = await fetchRaw(url, opts);
  try {
    return JSON.parse(text.text);
  } catch {
    throw new Error(`response was not JSON: ${url}`);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over items with at most `limit` in flight, politely spaced. */
export async function mapLimit(items, limit, fn, { onItem } = {}) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      if (onItem) onItem(results[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/* --------------------------------- app list --------------------------------- */

/**
 * Full list of Steam app ids — and the reason an update can be incremental.
 *
 * Every entry carries the `last_modified` Steam itself reports for that app, so
 * one download answers both "which games does the catalog not have" and "which
 * games have been touched since the catalog last read them". A refresh needs both
 * halves, which is why `lastModified` is carried out of here rather than thrown
 * away.
 *
 * The list is a community mirror of Steam's own app index, refreshed daily, and it
 * is genuinely current: measured on 2026-10-28, the newest `last_modified` in it
 * was seven hours old, and 7,369 games had been touched in the previous three
 * days. That last number is the size of an incremental refresh — thousands of
 * games, not a hundred and ninety thousand.
 */
export async function fetchAppList() {
  const data = await fetchJson(APP_LIST_URL, { label: 'app list', timeoutMs: 40000 });
  if (!Array.isArray(data)) throw new Error('app list is not an array');
  const out = [];
  for (const entry of data) {
    const appId = Number(entry?.appid ?? entry?.appId ?? entry?.app_id);
    if (!Number.isInteger(appId) || appId <= 0) continue;
    const lastModified = Number(entry?.last_modified ?? entry?.lastModified ?? entry?.lastmod);
    out.push({
      appId,
      name: String(entry?.name ?? entry?.title ?? '').trim() || null,
      lastModified: Number.isFinite(lastModified) && lastModified > 0 ? lastModified : null,
    });
  }
  return out;
}

/* ------------------------------- tag dictionary ------------------------------- */

/**
 * Steam's own tag list: name -> numeric tag id. Covers the popular ~430 tags,
 * which is the whole of what the catalog holds: a finished read indexes ~430 tags.
 */
export async function fetchPopularTags() {
  const data = await fetchJson(POPULAR_TAGS_URL, { label: 'popular tags', timeoutMs: 30000 });
  const byKey = new Map();
  if (!Array.isArray(data)) throw new Error('popular tags is not an array');
  for (const entry of data) {
    const id = Number(entry?.tagID ?? entry?.tagid ?? entry?.id);
    const name = String(entry?.name ?? '').trim();
    if (!Number.isInteger(id) || !name) continue;
    byKey.set(normalizeKey(name), { id, name });
  }
  return byKey;
}

/* -------------------------------- store page -------------------------------- */

const TAG_RE = /class="app_tag[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>/g;
const NAME_RE = /<div class="app_name">\s*([^<]+?)\s*<\/div>/;
const TITLE_RE = /<title>\s*(.*?)\s+on Steam\s*<\/title>/i;
const HUB_NAME_RE = /<h1 class="apphubAppName">\s*([^<]+?)\s*<\/h1>/;
const REVIEW_RE =
  /<div[^>]+id="game_review_summary"[^>]*data-total-review-count="(\d+)"[^>]*data-positive-review-count="(\d+)"[^>]*>/;
// Current storefront pages carry no `data-total-review-count` at all. The same
// numbers are published as schema.org microdata (`reviewCount`) and as the
// tooltip sentence, which is the only place the positive percentage appears:
//   93% of the 71,567 user reviews for this game are positive
const REVIEW_COUNT_META_RE = /<meta\s+itemprop="reviewCount"\s+content="(\d+)"/i;
const REVIEW_SENTENCE_RE =
  /(\d{1,3})\s*%\s*of\s*the\s*([\d,. ]+)\s*user reviews\s*(for this game|in your language|overall)/gi;
const REVIEW_TEXT_RE = /class="game_review_summary\s+([a-z_]+)"[^>]*>([^<]+)</;
const RELEASE_RE = /<div class="date"[^>]*data-date="(\d{4}-\d{2}-\d{2})"/;
const RELEASE_TEXT_RE = /<div class="date">\s*([^<]+?)\s*<\/div>/;
const EARLY_ACCESS_RE = /class="[^"]*early_access[^"]*"/;
// Steam embeds `is_free&quot;:1` in an escaped JSON blob on the page.
const FREE_RE = /is_free(?:&quot;|")\s*:\s*(?:1|true)/;
const NOT_FOUND_RE = /Sorry, we couldn'|couldn&#039;t find that page|Oops, sorry!|<title>Site Error/i;
const AGE_GATE_RE = /agecheck|class="agecheck_form"/i;

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Jun 18, 2020" / "18 Sep, 2020" / "18. Jun. 2020" / "2020-06-18" -> ISO date. */
function parseReleaseDate(text) {
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const monthFirst = text.match(/([A-Za-z]+)[. ]+(\d{1,2})[,. ]+(\d{4})/);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].slice(0, 3).toLowerCase()];
    if (month) return `${monthFirst[3]}-${pad2(month)}-${pad2(Number(monthFirst[2]))}`;
  }
  const dayFirst = text.match(/(\d{1,2})[. ]+([A-Za-z]+)[,. ]+(\d{4})/);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2].slice(0, 3).toLowerCase()];
    if (month) return `${dayFirst[3]}-${pad2(month)}-${pad2(Number(dayFirst[1]))}`;
  }
  const yearOnly = text.match(/\b(19|20)\d{2}\b/);
  return yearOnly ? `${yearOnly[0]}-01-01` : null;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Review figures from the markup Steam actually ships now: a percentage buried in
 * a tooltip sentence and a schema.org `reviewCount`. The sentence for all reviews
 * ("for this game") is preferred, because the 30-day figure appears earlier on
 * the page and would otherwise win.
 * Returns `{ count, percent }`, either of which stays null when absent.
 */
function parseReviewFigures(html) {
  const out = { count: null, percent: null };
  for (const match of html.matchAll(REVIEW_SENTENCE_RE)) {
    const percent = Number(match[1]);
    const count = Number(String(match[2]).replace(/[^0-9]/g, ''));
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(percent)) continue;
    out.count = count;
    out.percent = percent;
    if (/for this game|overall/i.test(match[3])) break;
  }
  if (out.count === null) {
    const meta = html.match(REVIEW_COUNT_META_RE);
    const count = meta ? Number(meta[1]) : NaN;
    if (Number.isFinite(count) && count > 0) out.count = count;
  }
  return out;
}

/**
 * Fetch and parse one storefront page.
 * Returns `{ appId, status, name, tags, reviewCount, reviewPercent, reviewLabel,
 *            releaseDate, isFree, isEarlyAccess, bytes, error }`.
 */
export async function fetchStorePage(appId, opts = {}) {
  const id = Number(appId);
  const out = {
    appId: Number.isInteger(id) && id > 0 ? id : null,
    status: 'ok',
    name: null,
    tags: [],
    reviewCount: null,
    reviewPercent: null,
    reviewLabel: null,
    releaseDate: null,
    isFree: false,
    isEarlyAccess: false,
    bytes: 0,
    error: null,
  };

  // Never build a URL out of garbage: a bad id would fetch `/app/undefined/`
  // and Steam answers with a page that parses as a tag-less product.
  if (out.appId === null) {
    out.status = 'error';
    out.error = `not a usable app id: ${JSON.stringify(appId)}`;
    return out;
  }

  let html;
  try {
    html = await fetchText(STORE_PAGE_URL(out.appId), { label: `app ${out.appId}`, ...opts });
  } catch (err) {
    out.status = err.status === 404 ? 'not_found' : 'error';
    out.error = err.message;
    return out;
  }
  out.bytes = html.length;

  if (NOT_FOUND_RE.test(html)) {
    out.status = 'not_found';
    out.error = 'store page missing';
    return out;
  }

  const nameMatch = html.match(NAME_RE) || html.match(HUB_NAME_RE) || html.match(TITLE_RE);
  if (nameMatch) out.name = decodeEntities(nameMatch[1]);

  const seen = new Set();
  for (const m of html.matchAll(TAG_RE)) {
    const name = decodeEntities(m[1]);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.tags.push({ name, weight: null });
  }

  const reviews = html.match(REVIEW_RE);
  if (reviews) {
    const total = Number(reviews[1]);
    const positive = Number(reviews[2]);
    if (Number.isFinite(total) && total > 0) {
      out.reviewCount = total;
      out.reviewPercent = Math.round((positive / total) * 1000) / 10;
    }
  } else {
    // Fallback: the summary block sometimes only renders the text.
    const totalText = html.match(/data-total-review-count="(\d+)"/);
    const posText = html.match(/data-positive-review-count="(\d+)"/);
    if (totalText) {
      out.reviewCount = Number(totalText[1]);
      if (posText && out.reviewCount > 0) {
        out.reviewPercent = Math.round((Number(posText[1]) / out.reviewCount) * 1000) / 10;
      }
    }
  }
  const label = html.match(REVIEW_TEXT_RE);
  if (label) out.reviewLabel = decodeEntities(label[2]);

  if (out.reviewCount === null || out.reviewPercent === null) {
    const figures = parseReviewFigures(html);
    if (out.reviewCount === null) out.reviewCount = figures.count;
    if (out.reviewPercent === null) out.reviewPercent = figures.percent;
  }

  const dateIso = html.match(RELEASE_RE);
  if (dateIso) {
    out.releaseDate = dateIso[1];
  } else {
    const dateText = html.match(RELEASE_TEXT_RE);
    if (dateText) out.releaseDate = parseReleaseDate(decodeEntities(dateText[1]));
  }

  out.isEarlyAccess = EARLY_ACCESS_RE.test(html);
  out.isFree = FREE_RE.test(html);

  // Last resort only. Steam currently redirects anonymous callers of the public
  // review endpoint straight to the store home, so this request usually buys
  // nothing; spend it only when the page visibly had reviews but no numbers.
  if (out.reviewCount === null && out.reviewLabel && opts.reviews !== false) {
    try {
      const summary = await fetchReviewSummary(appId, opts);
      if (summary) {
        out.reviewCount = summary.reviewCount;
        out.reviewPercent = summary.reviewPercent;
        out.reviewLabel = summary.reviewLabel;
      }
    } catch (err) {
      out.reviewError = err.message;
    }
  }

  if (!out.tags.length) out.status = 'no_tags';
  if (AGE_GATE_RE.test(html) && !out.tags.length && !out.reviewCount) {
    out.status = 'error';
    out.error = 'age gate blocked the page';
  }
  return out;
}

/**
 * Review totals for one app, from Steam's public review endpoint.
 * `{ reviewCount, reviewPercent, reviewLabel }`; null when Steam has no numbers.
 * As of 2026 Steam answers this endpoint with a redirect to the store home for
 * callers without a store session, which is why `fetchStorePage` reads the
 * figures off the page itself and only reaches here as a last resort.
 */
export async function fetchReviewSummary(appId, opts = {}) {
  const body = await fetchJson(REVIEWS_URL(appId), { label: `reviews for ${appId}`, ...opts });
  const summary = body?.query_summary || body?.data?.query_summary;
  if (!summary) return null;
  const count = Number(summary.total_reviews) || 0;
  const positive = Number(summary.total_positive) || 0;
  const label = String(summary.review_score_desc || '').trim() || null;
  return {
    reviewCount: count,
    reviewPercent: count > 0 ? Math.round((positive / count) * 1000) / 10 : null,
    reviewLabel: label,
  };
}

export { APP_LIST_URL, POPULAR_TAGS_URL, STORE_PAGE_URL, REVIEWS_URL, USER_AGENT };
