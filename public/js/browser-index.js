/**
 * The catalog loader: `data/catalog.bin.gz` into `engine/store.js`.
 *
 * One catalog file, one way to fill the index from it — the page and the local
 * server both call this, so the typed arrays, their order and the pair-key base
 * are the same in both homes.
 *
 * The parsing itself lives in `public/engine/snapshot.js`, because three things
 * read that file and one of them also writes it: the page, the local server, and
 * `scripts/update-snapshot.js`, which keeps the committed file current. One reader
 * means the page cannot be quietly reading a different file than the updater wrote.
 *
 * Kept deliberately small: no IndexedDB layer, because Pages serves the snapshot
 * with a `max-age`, so the browser's own HTTP cache already spares a repeat
 * visitor the download. The work left after a cache hit is decompress and build
 * the arrays, which is a few hundred milliseconds.
 */

import { store, resetAllAppCache } from '../engine/store.js';
import { readSnapshotCatalog, SNAPSHOT_FORMAT, SNAPSHOT_FORMAT_1 } from '../engine/snapshot.js';

export const SNAPSHOT_URL = new URL('../data/catalog.bin.gz', import.meta.url);
export { SNAPSHOT_FORMAT, SNAPSHOT_FORMAT_1 };

/** gzip starts with these two bytes wherever it came from. */
function looksGzipped(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Fetch the snapshot. A 404 on the `.gz` can mean a host that dropped the extension.
 *
 * Read as a stream rather than in one `arrayBuffer()`, so the page can say how much has arrived:
 * ~7 MB over a phone connection is the slowest thing that happens when this page opens, and silence
 * during it reads as a broken page. `progress(bytes, total)` is called roughly every 128 KB, and
 * `total` is 0 when the host sent no `Content-Length` — the caller then has a running count and no
 * percentage. The fallback path (no readable body) still reports once, at the end.
 */
async function fetchBytes(url = SNAPSHOT_URL, progress = () => {}) {
  let res = await fetch(url.href);
  if (res.status === 404) {
    res = await fetch(new URL('catalog.bin', url).href);
    if (!res.ok) throw new Error(`no catalog snapshot at ${url.pathname} (${res.status})`);
  }
  if (!res.ok) throw new Error(`catalog snapshot failed to load (${res.status})`);

  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const whole = new Uint8Array(await res.arrayBuffer());
    progress(whole.length, whole.length);
    return whole;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  let reported = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    got += value.length;
    if (got - reported >= 131_072) { reported = got; progress(got, total); }
  }
  progress(got, total || got);

  const packed = new Uint8Array(got);
  let at = 0;
  for (const chunk of chunks) {
    packed.set(chunk, at);
    at += chunk.length;
  }
  return packed;
}

/**
 * Fill `store` from the snapshot; `log` prints the progress line the local server
 * shows too.
 *
 * `bytes` lets a Node script feed the file straight in, which is how
 * `scripts/check-catalog.js` answers its battery against the exact bytes the page
 * downloads.
 *
 * `progress` is the page's loading report: `{ stage: 'fetch', bytes, total }` as the
 * file arrives, `{ stage: 'index', bytes }` once every byte is here and the work is
 * decompressing and building the typed arrays. It is only ever a *display* callback —
 * nothing about what gets indexed depends on it.
 */
export async function loadCatalogSnapshot({ log = () => {}, url = SNAPSHOT_URL, bytes = null, progress = () => {} } = {}) {
  const t0 = Date.now();
  const packed = bytes || (await fetchBytes(url, (got, total) => progress({ stage: 'fetch', bytes: got, total })));
  progress({ stage: 'index', bytes: packed.length });
  // Decided from the bytes, not the filename: a host that re-encodes a `.gz`, or a
  // Node script handing over whatever it read, both land here.
  if (!looksGzipped(packed)) log('catalog snapshot is not gzipped — reading it as written');
  const catalog = await readSnapshotCatalog(packed);

  store.nTags = catalog.tagIds.length;
  store.nGames = catalog.appId.length;
  store.nLinks = catalog.nLinks;

  store.tagIdOf = catalog.tagIds;
  store.tagName = catalog.tagNames;
  store.tagCount = catalog.tagCount;
  store.postings = catalog.postings;
  store.tagIndexOf = catalog.tagIndexOf;

  store.appIdOf = catalog.appId;
  store.rowOfApp = catalog.rowOfApp;
  store.nameOf = catalog.name;
  store.reviewsOf = catalog.reviews;
  store.pctOf = catalog.percent;
  store.labelOf = catalog.label;
  store.yearOf = catalog.year;
  store.flagsOf = catalog.flags;

  store.tagCountOfApp = catalog.tagCountOfApp;
  store.appTagStart = catalog.appTagStart;
  store.appTagFlat = catalog.appTagFlat;

  store.pairOf = catalog.pairOf;
  store.pairKeys = catalog.pairKeys;
  store.pairCounts = catalog.pairCounts;

  // Snapshot facts the interface quotes. None of them names a machine or a path
  // on one: the file carries its own dates in its header, so the same bytes that
  // answer on a laptop answer on the website.
  store.meta = new Map();
  store.meta.set('app_list_synced_at', catalog.lastSync);
  store.meta.set('snapshot_generated_at', catalog.generatedAt);
  store.meta.set('snapshot_format', catalog.format);
  store.lastSync = catalog.lastSync;

  resetAllAppCache();
  store.loaded = true;
  store.loadedAt = new Date().toISOString();
  store.loadMs = Date.now() - t0;
  log(
    `catalog loaded: ${store.nGames} games, ${store.nTags} tags, ${store.nLinks} links, ` +
      `${catalog.pairs.length} pairs in ${store.loadMs}ms`,
  );
  return { header: catalog.counts, format: catalog.format, loadMs: store.loadMs };
}
