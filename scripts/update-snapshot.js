#!/usr/bin/env node
/**
 * Keep the hosted catalog current — with the small file as the only store.
 *
 *   node scripts/update-snapshot.js [--in PATH] [--out PATH] [options]
 *
 *   --limit N          stop after N storefront pages this run
 *   --refresh N        cap the games re-read because Steam says they changed (default 5000)
 *   --new-only         fetch games the file has never seen, skip anything changed
 *   --recheck N        also re-read N games that Steam does not report as changed,
 *                      most recently modified first, to catch edits it never flagged
 *   --dry-run [N]      fetch N pages (default 10), print what would change, write nothing
 *   --delay MS         pause per page per worker (default 250)
 *   --concurrency N    simultaneous pages, 1-8 (default 3)
 *   --no-backup        skip the copy of the previous file in backups/
 *   --allow-shrink     write it even if the catalog came out smaller than the one read
 *   --quiet            no per-25-page progress lines
 *
 * ## Why this exists
 *
 * This one file is the catalog: the app runs on it, the page loads it, and the
 * numbers on the page come out of it. So keeping it current means reading it
 * *back*, working out which games are new and which Steam says have changed,
 * fetching only those storefront pages, and writing it again. Nothing else has to
 * be installed, and no second copy of the catalog exists to fall out of date.
 *
 * What makes that possible is `seen`, format 2's one extra column: the
 * `last_modified` Steam's own app list reported for a game when its page was last
 * read. Steam's list is public and one download covers every game, so "which
 * games are new" and "which games have been touched since I looked" are both
 * answerable from it. The file remembers the rest.
 *
 * ## What it never does
 *
 * It never drops a game, so the counts on a published site cannot fall. A page
 * that 404s or sits behind an age gate leaves its row exactly as it was. A page
 * that fails to fetch at all is retried on a later run.
 *
 * It never writes a smaller catalog than the one it read (pass `--allow-shrink` if
 * you genuinely mean to), and it keeps the bytes it read in `backups/` before
 * replacing the file, so a refresh can be undone.
 *
 * ## Politeness
 *
 * Three pages at a time, a quarter second apart per worker, so a run reads a few
 * storefront pages per second. Valve's robots.txt allows `/app/<id>/`
 * and asks for no delay; the slower pace here is because these runs are meant to
 * be left alone, possibly on somebody else's machine. `--limit` is the number that
 * bounds a run, so a scheduled one can never turn into a full crawl.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  readSnapshotCatalog,
  packSnapshot,
  refreshDerived,
  recountPairs,
  pairInvariantImplied,
  pairInvariantCounted,
  tagBook,
  SNAPSHOT_FORMAT,
} from '../public/engine/snapshot.js';
import { labelCode } from '../public/engine/store.js';
import { isPlaceholderName } from '../public/engine/tags.js';
import { fetchAppList, fetchPopularTags, fetchStorePage, mapLimit, sleep } from '../server/steam.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SNAPSHOT = path.join(ROOT, 'public', 'data', 'catalog.bin.gz');
const BACKUP_DIR = path.join(ROOT, 'backups');

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--') && argv[i].includes('=') && !argv[i].startsWith('--dry-run=')) {
    const [flag, value] = [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)];
    argv.splice(i, 1, flag, value);
  }
}
const flagValue = (name, fallback = null) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const raw = argv[i + 1];
  return raw === undefined || raw.startsWith('--') ? fallback : raw;
};
const numberFlag = (name, fallback) => {
  const raw = flagValue(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`${name} wants a number, got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return n;
};

const IN_PATH = path.resolve(flagValue('--in', DEFAULT_SNAPSHOT));
const OUT_PATH = path.resolve(flagValue('--out', IN_PATH));
const REFRESH_CAP = numberFlag('--refresh', 5000);
const RECHECK = numberFlag('--recheck', 0);
const LIMIT = numberFlag('--limit', 0) || null;
const NEW_ONLY = argv.includes('--new-only');
const DRY_RUN = argv.includes('--dry-run') ? numberFlag('--dry-run', 10) : null;
const DELAY = Math.max(0, numberFlag('--delay', 250));
const CONCURRENCY = Math.max(1, Math.min(8, numberFlag('--concurrency', 3)));
const NO_BACKUP = argv.includes('--no-backup');
const QUIET = argv.includes('--quiet');
const ALLOW_SHRINK = argv.includes('--allow-shrink');

const log = (...parts) => console.log(parts.join(' '));
const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
const epochOf = (iso) => {
  const ms = Date.parse(String(iso || ''));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
};
const stamp = (when = new Date()) => when.toISOString().replace(/\.\d{3}Z$/, '').replace(/[-:]/g, '').replace('T', '-');

/* ------------------------------- the merge rows ----------------------------- */
/*
 * One record per game, old or new, which is the only sane way to re-sort rows by
 * app id and rebuild every column in the same order. A finished catalog is 196k
 * of these, which is tens of megabytes — worth it against the alternative of
 * splicing eight typed arrays in lockstep by hand.
 */
const yearOf = (releaseDate) => {
  const m = /^(\d{4})/.exec(String(releaseDate || ''));
  return m ? Number(m[1]) : 0;
};
const flagsOf = (page) => (page.isFree ? 1 : 0) | (page.isEarlyAccess ? 2 : 0);
const reviewsOf = (page) => (page.reviewCount > 0 ? Math.round(page.reviewCount) : 0);
const percentOf = (page) => (Number.isFinite(page.reviewPercent) ? Math.round(page.reviewPercent) : -1);

/* ----------------------------------- run ----------------------------------- */

async function main() {
  if (!fs.existsSync(IN_PATH)) {
    console.error(`no catalog at ${IN_PATH}`);
    console.error('  that file is committed in this repository: restore it, or point --in at another copy.');
    process.exit(1);
  }
  const previousBytes = fs.readFileSync(IN_PATH);
  const tRead = performance.now();
  const catalog = await readSnapshotCatalog(previousBytes);
  log(
    `read ${path.relative(ROOT, IN_PATH)}: ${catalog.appId.length} games, ${catalog.tagIds.length} tags, ` +
      `${catalog.nLinks} links, ${catalog.pairs.length} pairs (format ${catalog.format}, ` +
      `generated ${catalog.generatedAt || 'unknown'}, ${Math.round(performance.now() - tRead)}ms)`,
  );
  if (catalog.format < SNAPSHOT_FORMAT) {
    log(`  format ${catalog.format} has no per-game \`seen\` column: this run stamps it from the app list ` +
      `and the header's sync time, and the file comes out as format ${SNAPSHOT_FORMAT}.`);
  }

  // Steam's two public lists: which games exist (with when each was last touched)
  // and what its tags are called. One request each.
  const listStartedAt = new Date();
  const [appList, mapping] = await Promise.all([fetchAppList(), fetchPopularTags()]);
  if (!Array.isArray(appList) || appList.length < 1000) {
    console.error(`the app list came back with ${appList?.length ?? 0} entries — refusing to treat that as the truth`);
    process.exit(1);
  }
  const listLmById = new Map();
  for (const app of appList) {
    const lm = Number(app.lastModified);
    if (Number.isFinite(lm) && lm > 0) listLmById.set(app.appId, lm);
  }
  log(
    `Steam says: ${appList.length} apps in the list (${mapping.size} tag names), ` +
      `app list read ${listStartedAt.toISOString()}`,
  );

  const book = tagBook(catalog);
  book.mergeSteamDictionary(mapping);

  // Which games to read. `seen` is what the file last captured; a format 1 file
  // has none, so its header's app-list sync time is the floor — a game Steam
  // touched *after* that stamp is genuinely something the file has never read.
  const floor = epochOf(catalog.lastSync);
  const newApps = [];
  const changedApps = [];
  const untouched = [];
  for (const app of appList) {
    const lm = listLmById.get(app.appId);
    const row = catalog.rowOfApp.get(app.appId);
    if (row === undefined) {
      newApps.push({ appId: app.appId, name: app.name, lm: lm ?? 0 });
      continue;
    }
    if (!lm) continue; // the list has no timestamp for it: nothing to compare against
    const seen = catalog.seen[row] || 0;
    const against = seen || floor;
    if (lm > against) changedApps.push({ appId: app.appId, name: catalog.name[row], lm, overdue: lm - against });
    else if (RECHECK > 0) untouched.push({ appId: app.appId, name: catalog.name[row], lm });
  }
  changedApps.sort((a, b) => b.lm - a.lm); // freshest news first, when a cap cuts the list short
  untouched.sort((a, b) => b.lm - a.lm);
  const targets = [
    ...newApps,
    ...(NEW_ONLY ? [] : changedApps.slice(0, Math.max(0, REFRESH_CAP))),
    ...(NEW_ONLY ? [] : untouched.slice(0, Math.max(0, RECHECK))),
  ];
  if (LIMIT) targets.length = Math.min(targets.length, LIMIT);

  log(
    `to read: ${newApps.length} new games` +
      (NEW_ONLY ? '' : `, ${changedApps.length} changed since the file last read them` +
        (changedApps.length > REFRESH_CAP ? ` (capped at ${REFRESH_CAP})` : '')) +
      (RECHECK > 0 ? `, ${untouched.length} older than that (re-checking ${Math.min(RECHECK, untouched.length)})` : '') +
      (LIMIT ? `, limited to ${targets.length} this run` : '') +
      ` — ${targets.length} storefront pages`,
  );
  if (!targets.length) {
    log('nothing to do: the file is current against Steam\'s own list.');
    return;
  }

  if (DRY_RUN !== null) {
    targets.length = Math.min(targets.length, DRY_RUN);
    log(`dry run: ${targets.length} pages fetched, nothing written.`);
  }

  /* ------------------------------- the crawl ------------------------------- */
  const job = { done: 0, requests: 0, errors: [], failed: 0, notFound: 0, ageGated: 0, usable: 0 };
  const started = performance.now();
  const pages = await mapLimit(targets, CONCURRENCY, async (app) => {
    const page = await fetchStorePage(app.appId);
    job.requests++;
    if (DELAY) await sleep(DELAY);
    job.done++;
    page.resolvedTagIds = page.status === 'ok' || page.status === 'no_tags'
      ? book.idsForNames((page.tags || []).map((tag) => tag.name))
      : [];
    if (page.status === 'not_found') job.notFound++;
    else if (page.error === 'age gate blocked the page') job.ageGated++;
    if (page.status === 'error' || page.status === 'not_found') {
      job.failed++;
      if (job.errors.length < 40) job.errors.push(`${page.appId}: ${page.error || page.status}`);
    } else {
      job.usable++;
    }
    if (!QUIET && job.done % 25 === 0) {
      const perSecond = (job.done / Math.max(1, performance.now() - started)) * 1000;
      log(`  fetched ${job.done}/${targets.length} (${perSecond.toFixed(1)} pages/s)`);
    }
    return page;
  });
  const usable = pages.filter((page) => page && (page.status === 'ok' || page.status === 'no_tags'));
  log(
    `crawled ${job.done} pages in ${Math.round((performance.now() - started) / 1000)}s: ` +
      `${job.usable} usable, ${job.notFound} gone from the store, ${job.ageGated} age-gated, ` +
      `${job.failed - job.notFound - job.ageGated} other failures`,
  );
  for (const line of job.errors.slice(0, 6)) log(`  skipped ${line}`);

  if (DRY_RUN !== null) {
    for (const page of usable.slice(0, 5)) {
      log(`  would write ${page.appId} "${page.name}" tags ${page.resolvedTagIds.length} ` +
        `reviews ${page.reviewCount ?? '—'} released ${page.releaseDate ?? '—'}`);
    }
    log(`dry run complete: ${usable.length} rows would change, ${book.added.size} tag names would be new` +
      (book.added.size ? ` (${[...book.added.keys()].slice(0, 6).join(', ')})` : '') + '. Nothing written.');
    return;
  }
  if (!usable.length) {
    log('no page came back usable — writing nothing. The published file keeps what it had.');
    return;
  }

  /* ------------------------------- the merge ------------------------------- */
  // Old tag lists, as tag ids, so a tag re-index (new tags sorting in) cannot
  // scramble them.
  const oldTagIdsByRow = [];
  for (let r = 0; r < catalog.appId.length; r++) {
    const start = catalog.appTagStart[r];
    const n = catalog.tagCountOfApp[r];
    const ids = [];
    for (let k = 0; k < n; k++) ids.push(catalog.tagIds[catalog.appTagFlat[start + k]]);
    oldTagIdsByRow.push(ids);
  }

  const readById = new Map();
  for (const page of usable) readById.set(page.appId, page);
  // A page that came back as gone or age-gated has been *seen* as far as Steam's
  // list is concerned: bump its stamp so the next run does not chase it forever.
  const settledById = new Map();
  for (const page of pages) {
    if (!page) continue;
    if (page.status === 'not_found' || page.error === 'age gate blocked the page') {
      settledById.set(page.appId, listLmById.get(page.appId) ?? 0);
    }
  }

  const rows = [];
  let refreshed = 0;
  let stampedOnly = 0;
  for (let r = 0; r < catalog.appId.length; r++) {
    const appId = catalog.appId[r];
    const page = readById.get(appId);
    if (page) refreshed++;
    const lm = listLmById.get(appId);
    rows.push({
      appId,
      name: (page?.name || catalog.name[r] || `App ${appId}`).trim(),
      flags: page ? flagsOf(page) : catalog.flags[r],
      year: page ? yearOf(page.releaseDate) : catalog.year[r],
      reviews: page ? reviewsOf(page) : catalog.reviews[r],
      percent: page ? percentOf(page) : catalog.percent[r],
      label: page ? labelCode(page.reviewLabel || '') : catalog.label[r],
      seen: page ? lm ?? catalog.seen[r] : settledById.get(appId) ?? catalog.seen[r],
      tagIds: page ? page.resolvedTagIds : oldTagIdsByRow[r],
    });
    if (!page && settledById.has(appId)) stampedOnly++;
  }
  let added = 0;
  for (const page of usable) {
    if (catalog.rowOfApp.has(page.appId)) continue; // a refresh of a game already in the file
    added++;
    rows.push({
      appId: page.appId,
      name: String(page.name || `App ${page.appId}`).trim(),
      flags: flagsOf(page),
      year: yearOf(page.releaseDate),
      reviews: reviewsOf(page),
      percent: percentOf(page),
      label: labelCode(page.reviewLabel || ''),
      seen: listLmById.get(page.appId) ?? 0,
      tagIds: page.resolvedTagIds,
    });
  }
  rows.sort((a, b) => a.appId - b.appId);

  // Tags: only the ones some game carries, in Steam's id order, because a tag with
  // no game behind it can never appear in a combination and would only cost the
  // file a posting list of nothing.
  const referenced = new Map(); // tag id -> name
  const dictNameById = new Map([...mapping.values()].map((entry) => [entry.id, entry.name]));
  let renamed = 0;
  for (const row of rows) {
    for (const id of row.tagIds) {
      if (referenced.has(id)) continue;
      const catalogName = book.byId.get(id)?.name || `Tag_${Math.abs(id)}`;
      // A `Tag_4132` placeholder is a crawl that never resolved a name. Steam's own
      // dictionary may have caught up since, and the file should stop calling a real
      // tag by its placeholder rather than carry the gap forever.
      const named = isPlaceholderName(catalogName) ? dictNameById.get(id) : null;
      if (named) renamed++;
      referenced.set(id, named || catalogName);
    }
  }
  const tagIds = [...referenced.keys()].sort((a, b) => a - b);
  const tagIndexOf = new Map(tagIds.map((id, i) => [id, i]));

  const appId = new Int32Array(rows.length);
  const name = new Array(rows.length);
  const flags = new Uint8Array(rows.length);
  const year = new Uint16Array(rows.length);
  const reviews = new Int32Array(rows.length);
  const percent = new Int8Array(rows.length);
  const label = new Uint8Array(rows.length);
  const seen = new Uint32Array(rows.length);
  const postings = tagIds.map(() => []);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    appId[r] = row.appId;
    name[r] = row.name;
    flags[r] = row.flags;
    year[r] = row.year;
    reviews[r] = row.reviews;
    percent[r] = row.percent;
    label[r] = row.label;
    seen[r] = row.seen || 0;
    for (const tagId of row.tagIds) {
      const ti = tagIndexOf.get(tagId);
      if (ti !== undefined) postings[ti].push(row.appId);
    }
  }
  const merged = {
    format: SNAPSHOT_FORMAT,
    tagIds: Int32Array.from(tagIds),
    tagNames: tagIds.map((id) => referenced.get(id)),
    tagCount: new Uint32Array(tagIds.length),
    postings: postings.map((list) => Int32Array.from(list)),
    appId,
    name,
    flags,
    year,
    reviews,
    percent,
    label,
    seen,
    pairs: [],
    lastSync: listStartedAt.toISOString(),
  };
  refreshDerived(merged);

  const tPairs = performance.now();
  recountPairs(merged);
  const implied = pairInvariantImplied(merged.tagCountOfApp);
  const counted = pairInvariantCounted(merged.pairs);
  log(
    `merged: ${merged.appId.length} games (+${added} new, ${refreshed} refreshed, ` +
      `${stampedOnly} left alone but marked as seen), ${merged.tagIds.length} tags ` +
      `(${book.added.size} names new to the file), ${merged.nLinks} links, ` +
      `${merged.pairs.length} pair counts recounted in ${Math.round(performance.now() - tPairs)}ms`,
  );
  if (counted !== implied) {
    console.error(
      `pair invariant BROKEN: pair counts add up to ${counted}, the links imply ${implied}. ` +
        'Nothing was written.',
    );
    process.exit(1);
  }
  log(`pair invariant OK: ${counted} pair-links on both sides`);

  if (renamed) log(`  ${renamed} tag names Steam has since resolved out of placeholders like \`Tag_4132\``);
  if (book.added.size) {
    log(`  ${book.added.size} tag names this file had never seen: ${[...book.added.keys()].slice(0, 8).join(', ')}`);
  }

  if (merged.appId.length < catalog.appId.length && !ALLOW_SHRINK) {
    console.error(
      `refusing to shrink the catalog: it held ${catalog.appId.length} games, this run would leave ` +
        `${merged.appId.length}. That is a bug, not an update — pass --allow-shrink if you mean it.`,
    );
    process.exit(1);
  }

  /* -------------------------------- the write ------------------------------- */
  const packed = packSnapshot(merged, { generated_at: new Date().toISOString() });
  const gz = zlib.gzipSync(Buffer.from(packed.bytes), { level: 9 });

  if (!NO_BACKUP) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backup = path.join(BACKUP_DIR, `catalog.${stamp()}.bin.gz`);
    fs.writeFileSync(backup, previousBytes);
    log(`previous snapshot kept: ${path.relative(ROOT, backup)} (${mb(fs.statSync(backup).size)})`);
  }

  // Write beside, then move: a run that dies halfway leaves the published file
  // exactly as it was rather than half a catalog.
  const tmp = `${OUT_PATH}.writing`;
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(tmp, gz);
  fs.renameSync(tmp, OUT_PATH);

  log(
    `wrote ${path.relative(ROOT, OUT_PATH)}: ${mb(packed.bytes.length)} raw → ${mb(gz.length)} gzipped ` +
      `(was ${mb(fs.statSync(IN_PATH).size)})`,
  );
  log(
    `  ${merged.appId.length} games · ${merged.tagIds.length} tags · ${merged.nLinks} links · ` +
      `${merged.pairs.length} pairs · app list read ${merged.lastSync}`,
  );
  if (OUT_PATH !== IN_PATH) log(`  read from ${path.relative(ROOT, IN_PATH)}, wrote ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch((err) => {
  console.error(`update failed: ${err.stack || err.message}`);
  process.exit(1);
});
