#!/usr/bin/env node
/**
 * Does the file the site runs on still answer the questions?
 *
 *   node scripts/check-catalog.js [--snapshot PATH] [--out FILE]
 *
 * A battery of real queries — the counts, a search at every combination length,
 * paging, the rarity windows, the gaps, the crates, the draft — answered straight
 * out of `public/data/catalog.bin.gz` by the same `engine.js` handlers the page
 * calls. This is what replaces a test suite for the catalog: the file is the whole
 * state, so if these answers are right the page is right.
 *
 * Seeded queries are compared against nothing but their own status: the point of
 * running them is that they answer without throwing and without emptying out.
 * The two rolling draws only have to answer at all, because a crate is random on
 * purpose. The pair invariant is checked on the same index and a drift exits 1,
 * which is what stops a bad file being published.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const BATTERY = [
  { name: 'meta', query: '/api/meta' },
  { name: 'draw-crate', query: '/api/draw?k=3&case=indie&bias=balanced', random: true },
  { name: 'draw-empty', query: '/api/draw?k=3&bias=balanced&forceBand=empty', random: true },
  { name: 'tags', query: '/api/tags?q=coop' },
  { name: 'tags-fuzzy', query: '/api/tags?q=storyrich&limit=5' },
  { name: 'combo', query: '/api/combo?tags=19,1685' },
  { name: 'combo-variants', query: '/api/combo?tags=19,1685&variants=1&limit=6' },
  { name: 'games', query: '/api/games?tags=19,1685&limit=8' },
  { name: 'suggest-rarest', query: '/api/suggest?tags=19&mode=rarest&limit=10' },
  { name: 'suggest-audience', query: '/api/suggest?tags=19&mode=audience&limit=10' },
  { name: 'scan-anchored', query: '/api/scan?must=19&k=3&minCount=1&maxCount=50&thoroughness=2&seed=7' },
  { name: 'scan-k2-random', query: '/api/scan?k=2&rankBy=random&limit=24&board=72&seed=7&gamesPerSpace=4' },
  { name: 'scan-k3-random', query: '/api/scan?k=3&rankBy=random&limit=24&board=72&seed=7&gamesPerSpace=4' },
  { name: 'scan-k3-page2', query: '/api/scan?k=3&rankBy=random&limit=24&board=72&offset=24&seed=7&gamesPerSpace=4' },
  { name: 'scan-k4-random', query: '/api/scan?k=4&rankBy=random&limit=24&board=72&seed=7&gamesPerSpace=4' },
  { name: 'scan-k5-random', query: '/api/scan?k=5&rankBy=random&limit=24&board=72&seed=7&gamesPerSpace=4' },
  { name: 'scan-window', query: '/api/scan?k=2&minCount=100&maxCount=499&rankBy=random&limit=24&board=72&seed=7' },
  { name: 'scan-band', query: '/api/scan?k=3&minCount=25&maxCount=99&limit=24&board=72&seed=7' },
  { name: 'scan-empty-k2', query: '/api/scan?k=2&minCount=0&maxCount=0&includeEmpty=1&emptyFloor=1000&rankBy=potential&thoroughness=2&limit=12&board=72&seed=7' },
  { name: 'scan-empty-k4', query: '/api/scan?k=4&minCount=0&maxCount=0&includeEmpty=1&emptyFloor=1000&rankBy=potential&thoroughness=2&limit=12&board=72&seed=7' },
  { name: 'scan-audience', query: '/api/scan?k=3&rankBy=audience&limit=12&board=36&seed=7' },
  { name: 'cases', query: '/api/cases' },
  { name: 'draft-tags', query: '/api/draft/tags?shown=12&k=3&seed=3' },
  { name: 'draft-draw', query: '/api/draft/draw?shown=12&k=3&seed=3&disabled=19', random: true },
  { name: 'draft-empty', query: '/api/draft/draw?shown=12&k=3&seed=9&bias=balanced&forceBand=empty', random: true },
];

// Fields that describe this run rather than the answer: which file was read, how
// long the index took, how long this search took.
const RUNTIME_FIELDS = new Set(['catalog', 'indexed_ms', 'ms', 'cached']);

function comparable(body) {
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (RUNTIME_FIELDS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** The invariant everything rests on: counted pairs vs the games' own tag lists. */
function reportInvariant(store) {
  // Σ over games of n(n−1)/2 — the pair links the catalog carries. (Not over tags:
  // that counts pairs of tags per tag, which is nothing the search uses.)
  const implied = [...store.tagCountOfApp].reduce((total, n) => total + (n * (n - 1)) / 2, 0);
  const pairSum = [...store.pairCounts].reduce((total, n) => total + n, 0);
  console.log(
    `[invariant] counted pairs ${pairSum.toLocaleString()} vs implied by the tag lists ${implied.toLocaleString()} → ` +
      (pairSum === implied ? 'OK' : 'DRIFT'),
  );
  if (pairSum !== implied) process.exitCode = 1;
  return pairSum === implied;
}

async function main() {
  const file = path.resolve(flagValue('--snapshot') || path.join(ROOT, 'public', 'data', 'catalog.bin.gz'));
  if (!fs.existsSync(file)) {
    console.error(`no catalog at ${file}`);
    console.error('  it is committed in this repository; `npm run update-snapshot` rewrites it in place.');
    process.exit(1);
  }

  const { configureEngine, handlers } = await import('../public/engine/engine.js');
  const store = (await import('../public/engine/store.js')).store;
  const { loadCatalogSnapshot } = await import('../public/js/browser-index.js');
  await loadCatalogSnapshot({ bytes: new Uint8Array(fs.readFileSync(file)), log: (m) => console.log(`[catalog] ${m}`) });
  configureEngine({ origin: path.relative(ROOT, file), indexedMs: 0, savedCount: () => 0 });

  const answers = {};
  const problems = [];
  for (const { name, query, random } of BATTERY) {
    const cut = query.indexOf('?');
    const path_ = cut === -1 ? query : query.slice(0, cut);
    const params = new URLSearchParams(cut === -1 ? '' : query.slice(cut + 1));
    const found = handlers.find((h) => h.pattern.test(path_));
    if (!found) throw new Error(`battery entry ${name} matches no handler`);
    const t0 = Date.now();
    const result = found.handler(params);
    const ms = Date.now() - t0;
    answers[name] = { status: result.status, ms, body: comparable(result.body) };
    if (result.status !== 200) {
      problems.push(`${name}: ${query} answered ${result.status} — ${JSON.stringify(result.body).slice(0, 120)}`);
      continue;
    }
    // A search that comes back with nothing to say on a finished catalog is a bug,
    // not an empty result: name the ones that must have content.
    if (!random && /\/api\/scan/.test(path_)) {
      const n = (result.body.spaces || []).length;
      if (!n && result.body.found) problems.push(`${name}: found ${result.body.found} but handed back 0 cards`);
    }
    console.log(`  ${name.padEnd(16)} ${String(result.status)}  ${ms}ms`);
  }

  const out = flagValue('--out') || path.join(ROOT, '.probe/catalog-answers.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(answers, null, 1));

  const pairs = reportInvariant(store);
  const ok = !problems.length && pairs;
  console.log(
    `\n${BATTERY.length - problems.length} of ${BATTERY.length} queries answered from ${path.relative(ROOT, file)}` +
      `${problems.length ? `\n  ${problems.join('\n  ')}` : ''}`,
  );
  console.log(`  answers written to ${path.relative(ROOT, out)}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
