# AGENTS.md — internals

[README.md](README.md) is for humans; this file is for whoever works on the code next. A behaviour change
updates both files in the same pass.

Steam Tags Explorer answers questions about **tag combinations** with exact counted facts. One catalog —
the committed `public/data/catalog.bin.gz` — and one engine, run in Node here and in a visitor's browser on
the site. `scripts/check-catalog.js` proves that file answers the questions the page asks.

## How to write, here and in the README

Plain, short, human sentences. Say what the app does and what happens when you press something. Describe,
do not argue, do not hedge. Use the words the interface already uses; do not invent names for things. State
what the code does today, not what it used to do. A sentence that carries no fact gets deleted.

## Rules

1. **Zero dependencies.** No package, framework, bundler, build step or test runner. Node builtins only.
2. **One catalog file, no database.** That ~7 MB file is the entire state.
3. **Never start an open-ended crawl to test something.** Always `--limit`, always a copy under `.probe/`.
   Refreshing the real file is the human's call, or the workflow's.
4. **Never run `git`.** The human drives version control.
5. **Counts stay exact.** No estimates, nothing that changes what a number means. A card's `count` is a real
   intersection; a window's `found` is what the search enumerated. Which cards a *board* shows is separate:
   under an open rarity window or `rankBy=random` the board is a sample of what was counted, which is why
   two presses answer differently.
6. **One writer for the file:** `snapshot.js` owns the format, `update-snapshot.js` is the only refresher.
7. **Nothing writes through the server.** A `POST`/`DELETE` is `404`. Saved combinations are browser
   localStorage (key `steamtage:spaces`).
8. **No test suite, no browser automation in the repo.** A change is done when the checks under [Testing](#testing)
   pass. A throwaway Chrome DevTools-Protocol probe (Node's built-in `WebSocket`) is fine under `.probe/`,
   never in `scripts/`.
9. Keep this file under 65,536 bytes: the harness injects it, and a longer one is read truncated.

## Layout

| Path | Owns |
| --- | --- |
| `server/steam.js` | Every outbound request: `fetchAppList` (with `lastModified`, which makes updates incremental), `fetchPopularTags`, `fetchStorePage`, `fetchReviewSummary`, `parseReviewFigures`. Only `update-snapshot.js` calls it. |
| `public/engine/` | **The portable half — the only place counting lives.** `store.js` (typed arrays, `pairKey`, `PAIR_BASE`, `gamesWithAll`, `gameView`/`tagView`), `tiers.js` (the eight bands), `tags.js` (`normalizeKey`, `isPlaceholderName`), `combos.js` (`scanSpaces`, `comboSummary`, `suggestTags`, `drawCombo`, `CASES`, `draftPoolView`/`draftDraw`, `poolCensus`, `bandAvailability`, `emptyNeighbors`), `engine.js` (every read route as a `(URLSearchParams) => {status, body}` handler), `snapshot.js` (**the codec**, only reader *and* writer). No `node:` import and no `process` here: the browser loads these bytes unchanged. |
| `server/server.js` | The local transport: index the file through `browser-index.js`, route the `engine.js` handlers, serve `public/`. |
| `public/` | The client and the whole hosted site: `index.html` (four panels, one `.console-*` skeleton each), `styles.css`, `favicon.svg`, `.nojekyll`, `data/catalog.bin.gz`, and `js/` — `main.js`, `local-api.js` (calls the engine handlers in-process; owns localStorage), `browser-index.js`, `ui.js`, `rarity.js`, `finder.js`, `crate.js`, `reel.js`, `draft.js`, `uncharted.js`, `vault.js`, `reveal.js`, `sound.js`, `fx.js`. DOM by hand; `fetch` only for the snapshot. |
| `scripts/` | `update-snapshot.js` (catalog → itself) and `check-catalog.js` (25 queries + the pair invariant; `--snapshot PATH`, `--out FILE`). |

## The invariant

Counted pair totals must equal the pairs implied by the games' own tag lists — Σ `n(n−1)/2`.
`update-snapshot.js` recounts every pair from scratch (`recountPairs`, ~1 s for ~81k pairs) and refuses to
write unless both sides match. `npm run check-catalog` prints
`[invariant] counted pairs 26,053,627 vs implied by the tag lists 26,053,627 → OK` and exits non-zero on
drift; the workflow gates a publish on it. Not cosmetic: `scanSpaces` uses pair counts as an admissible
upper bound when pruning the beam, so counts that drift low silently prune real combinations.

## The index (`store.js`)

Column-oriented typed arrays, filled by `public/js/browser-index.js` in **both** homes — one loader, so
server and page cannot disagree. Loading and indexing the current file takes about 350 ms.

- `tagIndexOf` (Steam id → index), `tagName`, `tagCount`, `postings` (per tag, ascending app ids);
  `rowOfApp`, `nameOf`, `reviewsOf`, `pctOf` (`-1` unknown), `labelOf`, `yearOf` (`0` unknown), `flagsOf`
  (bit0 free, bit1 early access), `appTagStart`/`appTagFlat`; `pairOf` (Map key→count), `pairKeys` /
  `pairCounts` (sorted by count ascending).
- Tags with zero games are left out of the index and every pool.
- **`nameOf` is trimmed during decoding** (a few hundred titles carry a stray space). No per-view trims.
- **`pairKey(i, j) = i * 1024 + j`** (`PAIR_BASE`, `i < j`): keys collide silently past 1024 indexed tags. A
  full crawl indexes ~430; a bigger dictionary means raising `PAIR_BASE` and `pairParts` together.
- The per-game columns are **display, not filtering** — nothing narrows a search by them, and `deriveLabel`
  recomputes the label from count + percent with the stored code as fallback. They cost ~209 KB of the 7 MB
  download; dropping one is a format change (chunks + views + format bump).

## The format (format 2, `snapshot.js`)

`"STEX" | u16 format | u32 header length | header JSON | zero pad to 4 | 4-byte-aligned chunks`. The
header's `layout` names every chunk with offset and length, so loading is a stack of subarray views. The
current file is ~13.1 MB raw, ~7.0 MB gzipped; level 9 is as good as gzip gets here.

- Postings are delta varints. `appTagStart`/`appTagFlat` are **rebuilt on load** by `refreshDerived`.
- Pairs travel as `(u16,u16,u32)`, already sorted by count, because the beam walks them in that order.
- Chunk offsets are body-relative, so the header carries **`body_offset`**, settled by `packSnapshot` in a
  loop: one extra header byte shifts the body and every typed-array view loses 4-byte alignment.
- **`seen`** — per game, the app list's `last_modified` when that game's page was last read; 0 means the row
  came from format 1, so the header's `last_sync` is the floor. It is what makes the file self-updating;
  nothing on the page reads it. Format 1 files still load.

## Refresh and check

`npm run update-snapshot`: read the file → app list + popular-tags dictionary → select games Steam reports
new (absent id) or changed (`last_modified > seen`, floor `last_sync`) → fetch those store pages (404 and
age-gated pages leave their row untouched) → rebuild postings and tags → `refreshDerived` → `recountPairs` →
the invariant gate → gzip, previous bytes to `backups/`, write `*.writing` then `renameSync`. It never
deletes a game, and exits non-zero rather than writing a **smaller** catalog than the one it read unless
`--allow-shrink`: a smaller catalog would lower every count with nothing visibly wrong. Flags:
`--in --out --limit --refresh --new-only --recheck N --dry-run [N] --delay --concurrency --no-backup
--quiet --allow-shrink`. Defaults `--delay 250 --concurrency 3`. `--recheck N` also re-reads N games Steam
does *not* report as changed, most recently modified first — tag edits Steam never flags. `--refresh N` caps
changed games per run (default 5,000) and is how a slice gets re-parsed after a scraper change. A dictionary
tag no game carries yet gets a **negative**
provisional id and a `Tag_<n>` name that `isHiddenTag` hides until a game uses it.

`npm run check-catalog`: 25 real queries (counts, a search at each length 2–5, page 2 of a board, rarity
windows, the blank sweep at two lengths, crates, the draft) answered from the file by the same `engine.js`
handlers, plus the invariant. A non-200, `found > 0` with no cards back, or invariant drift exits non-zero.

## Publishing

`.github/workflows/publish-site.yml` is one job: crawl Steam (allowed to fail) → `check-catalog` → commit the
file if it changed → upload `public/` as a Pages artifact → deploy. Scheduled `0 0 */3 * *` (every third day
at midnight UTC) and by hand. The manual choice **"publish as it is"** skips the crawl; a crawl that *fails*
still publishes, because the file then is the one that was already committed, and `check-catalog` between
them is what stops a file that answers nothing from going out. The crawl is the fragile half — datacenter
addresses get age-gated or blocked — so it paces at `--delay 500 --concurrency 2 --limit 12000`, gentler
than a local run because that address belongs to GitHub. When it is blocked the site keeps the previous file,
and `generated_at`/`last_sync` say which. Set by hand: Settings → Pages → Source: **GitHub Actions**. No
build step: `public/` is published exactly as it sits in the repo, plus the data file; `public/.nojekyll`
keeps Pages from running Jekyll. Asset paths stay **relative**, and `browser-index.js` resolves the snapshot
from `import.meta.url`, never `location.origin`.

## Rarity (`tiers.js`, `public/js/rarity.js`)

`empty` 0 · `almost_empty` 1–4 · `very_rare` 5–24 · `rare` 25–99 · `uncommon` 100–499 · `fairly_common`
500–2,499 · `common` 2,500–9,999 · `very_common` 10,000+. Ids are API surface (`?forceBand=fairly_common`);
labels and blurbs are UI copy. The `empty` band's `weight` sets its share of a roll, and `rollWeights`
deliberately does not multiply it by the rarity bias.

One select per panel, identical options in all three: *Any rarity*, *Prioritize rare*, *Prioritize common*,
then `Guarantee <band>` for every band in `/api/meta` (11 options; `value` is the raw `tier.id`). The leans
are halves, not bands (`lean_rare` 0–99, `lean_common` 100+); ranges live in an option's `title`, never its
label. In the **Finder** an option is a **window** (`rarityWindow()` → `minCount`/`maxCount`, plus
`includeEmpty=1` for *Any rarity*; ceiling `NO_CEILING = 1_000_000` because `serializeTiers()` sends
`max: null`); in a **draw** it is a **roll** (`rarityDraw()` → `bias=balanced|seeker|magnet`, or
`bias=balanced` + `forceBand`).

`bandAvailability(k)`, exposed as `/api/meta`'s `band_gaps`, drives what `applyRarityAvailability()` greys
out (`Very common: not possible with 5 tags`); a band greyed because the catalog holds no combination of
that length is a correct answer, usually a partial catalog. `rollBands`/`rollRange` fix what each unaimed
option may hand out (`balanced` all eight, `seeker` `empty`…`rare`, `magnet` `uncommon`…`very_common`), and
`pickWeightedTier`, `fallbackBands`, the rescue pass and the draft's `pickHeldTier` all stay inside them. A
*Guarantee* whose band does not exist at that length slides to the closest one that does (`neighbourTiers`,
reported by `aimFields`), but the panels grey those options first so it cannot be pressed.

`markRarityLegend` lights the rows of the block beside the control: a guarantee lights one band, the leans
light their whole half **including `empty`**, *Any rarity* lights nothing; all three panels light the same
rows. Every `change` handler re-applies availability **and** re-marks the legend. The crate block exists only
in Random draw, because that is where the crate is chosen. Rows come from `/api/meta`, so they cannot
disagree with the engine.

A draw payload carries `target_tier`/`landed_other_tier`/`aim_moved` **only for a band the reader named**,
and the page prints nothing from them — there is no aim sentence in the client. The control is what keeps the
promise: what cannot be offered is greyed before it can be chosen, and the option's own range is what the
draw rolls inside. Draft keeps its selection-time note only.

## Tag chips: one tag, one click, never an automatic search

`ui.js tagChip` renders `span.chip.chip-ghost[data-tag="<tag id>"]`. `pickedIds` may be a `Set` **or a live
predicate**; cards always take a predicate, because a `Set` goes stale when another panel clicks.

Every chip click goes through `toggleTagInFinder` (`main.js`): the tag enters the Finder box **or comes back
out**, `#finderK` rises only upward, and the reader presses Search. A full box says `A combination holds at
most 5 tags. Take one out before adding <name>.` Inside the Finder a card chip calls `toggleFilterTag`,
editing the box and leaving the board until the next press. A control naming a **whole combination** (ladder
rung, draw-history row, card jump button, saved row) calls `openInFinder(tags, { run: true })`;
`comboJumpAction()`/`jumpLabel()` in `vault.js` are the only source of that button and its words — **Search
this combination** while the Finder tab shows, **Open in Finder** elsewhere — repainted on `steamtage:view`.
Nearest combinations are the exception: `emptyNeighbors` renders `button.neighbor` and opens **without**
searching, because they describe what sits beside the gap.

The gold mark follows the **tag box**, not the panel that changed it: `renderChips()` ends with
`markEveryPickedChip()`, which walks every `.chip-ghost[data-tag]` in the document, and `announceTags()`
dispatches `steamtage:tags`. **Clear** strips the mark everywhere. `.chip-ghost:hover` sits behind
`@media (hover: hover)` and adds only an edge; the gold text and tint belong to `.is-picked` alone, because
a touch screen leaves `:hover` on the tapped element until the next tap elsewhere.

## Panels, boot, busy state

Four modes share one skeleton: `section.console[-finder|-crate|-draft|-space]` → `.console-head` → (crate
block, Random draw only) → `.console-body` (controls, then the rarity block; legend below at ≤1000px) → the
mode's material. Draft pick is the exception: **Show new tags** and **Open crate** come after `#draftPool`,
because those buttons act on the pool.

`fx.js scrollToInterest(node)` brings an answer into view, but only when it is genuinely out of hand: the
target's **own top edge** below the sticky bar **and** at least `minVisible` (200 px) of it showing. Paging
a board that is already open never calls it; targets reserve room with `scroll-margin-top`. Nothing scrolls
sideways: `overflow-x: clip` on `html, body` — `clip`, not `hidden`, which would stop the sticky bar sticking
— grids are `minmax(0,1fr)` with `min-width: 0` children. Breakpoints: 1240, 1000, 760, 640, 560, 380. Keep
the arithmetic commented next to any measured number you change; `trackTopbar` measures the bar rather than
assuming a height.

Nothing answers until the file has been downloaded and indexed **in that browser**, so `index.html` writes
`class="is-booting"` on `<html>` — in the markup, so the first painted frame is gated — and `main.js` removes
it once every panel is wired and has written its empty state. Until then `.view, .vault` are `display: none`,
the strip takes no clicks and every `.tab` is `disabled`, and the `#boot` block (`role="status"
aria-live="polite"`) reports bytes arriving with a bar, then unpacking and indexing; `browser-index.js` reads
the response with `getReader()` to make those bytes visible. A failed load reports on that same block, with
the reason and a **Try again**.

`setBusy(panel, { button, label, disable })` and `nextFrame()` in `ui.js` own the busy state; all four modes
call them. The panel takes `.is-busy` and `aria-busy="true"`, everything that could start a second job is
disabled, the button names the work (**Searching…**, **Opening…**), and the returned function restores each
control's **previous** disabled state — so Draft's **Open crate** comes back still unavailable under its own
rule. `local-api.js` calls the engine in-process, so a search is one synchronous task on the page's thread
and nothing paints while it runs; each mode paints the grey state and waits one painted frame before asking.
A button's width is reserved **before** its words change, so no control moves; a superseded press must not
lift a newer one's grey — Finder's `seq`, Missed's `sweepSeq`, the draft's `wantedSeed` guard the call to
`stop()`. A board page and a card's games pill grey **themselves**, not the panel around them.

## Search internals (`combos.js scanSpaces`)

- Widths and budgets by `thoroughness` 1–3: `BEAM_WIDTHS = [1400, 3400, 7000]`, `LEAF_CAPS = [800, 1600,
  3000]`, `NODE_BUDGETS = [700_000, 2_000_000, 4_500_000]`; `rankBy=audience` multiplies by 0.6; `k` clamped
  2–5. Depth is the search's decision: `AUTO_DEPTH = { 2: 3, 3: 3, 4: 2, 5: 2 }` when `thoroughness` is
  omitted (what the Finder does); an explicit value wins (the Missed sweep passes 2).
- **One search, one board; pages are slices.** `limit` is one page (Finder 24, Missed 12), `board` is the
  total width the caller will walk, `MAX_BOARD = 150` caps it: `want = min(MAX_BOARD, max(limit, board ||
  offset + limit))`, answered `board.slice(offset, offset + limit)`. `board_total` is the whole board's
  length, and `spaces.length < board_total` is what puts a "Show N more combinations" pill under it. Both
  modes page with **one `seed` per press** and must **repeat `board` on every page**: sending only
  `limit`/`offset` grows `want`, which moves the beam caps, the blank quota and the reuse cap, so pages stop
  being slices of one answer.
- `paintMoreControl(host, state, opts)` in `ui.js` builds every "Show N more" pill — a card's games, both
  boards, a saved row's — owning wording, insertion **before** the pill, the pending word, the
  disabled-error state. `load()` resolves to `{ items, total }`, and that is also what `onLoaded` receives,
  so a panel whose stat line describes **this page** (the Finder's does) has to spread the payload in.
- Empty quota is a fixed handful, `max(2, min(8, round(want * 0.35)))`, not a share: at `k` 4–5 under
  `rankBy=audience` the shortlist is nearly all zero-count mixes, and a scaling quota would pad the board
  with gaps. `blankOnly` is exempt.
- Cache: `SCAN_CACHE_MAX = 40`, TTL 5 min, a hit answers `cached: true`; nothing resets it and a boot starts
  empty. The key carries every parameter that changes an answer — `k`, the resolved window, `includeEmpty`,
  `emptyFloor`, `rankBy`, `limit`, `offset`, `board`, the resolved `want`, `thoroughness`, `poolCap`,
  `maxTagReuse`, `must`, `seed`. A scan parameter left out of the key is a parameter whose answer is someone
  else's cache.
- `OPENNESS_CAP = 20000`. `maxTagReuse` (default 2; `drawCombo` drops it to 1 for its audience rescue) and
  `poolCap` are engine-internal, not HTTP parameters — the page sends neither.
- `emptyFloor` (default 150, clamped 1–50000) filters the **candidate pool** in empty-only mode to tags
  carried by at least that many games. It is in the cache key and echoed as `empty_floor`, which is what the
  panels print. Missed overrides it with 250 / 1,000 / 3,000 / 10,000 starting at 1,000; the Finder's
  *Guarantee empty* has no floor control, searches at 150 and says so. Internally the mode is `blankOnly`;
  the API says `includeEmpty`/`emptyFloor`.
- **A guaranteed band is a window and must not be pruned away:** the pair walk's ceiling is
  `pairCeiling = max(40_000, minCount * 10)`, feeding `boundCap` (only ~10 of ~81k pairs exceed 40k, largest
  ~82k). Too low answers `found: 0` with no error — touch `boundCap` and re-measure the guaranteed windows.
- A card's `count` must equal `/api/games`' `total` for the same ids: one count, one list of games under it.
- `rankBy=audience` ranks by review **mass**, not average (stage 2 compares `demand_sum`, then `avg_reviews`,
  then `count`; stage 1's proxy is `heatProxy * count`). `demandOfRow` is `reviews × pct / 100`, `pct`
  standing at 70 when unknown.
- `rankBy=random` samples rather than re-ranks: same beam, same `found`, a `roll` on each candidate pushed
  into `found`. `rankBeam` is untouched, so `potential`/`rarest`/`random` report identical `found` and
  `scanned_candidates` and only the cards differ — a random board is still exact. The Finder draws a fresh
  `runSeed` per press and reuses it for paging, so page 2 is more of the same sample in the same order.
- The stream is `seedStream`: xorshift128 with the seed mixed by SplitMix32 into the 128-bit state. The mixer
  matters — an unmixed counter generator gives early numbers correlated across seeds, so two presses asking
  the same question land on nearly the same cards. Keep it 32-bit: a length 4–5 press draws 1–2 M numbers,
  and a BigInt state costs ~290 ms per 2 M draws against ~10. The stream advances as the search consumes it,
  so it is **not** a pure function of the seed.
- **A press answers something different on purpose.** `spreadByBound` keeps the beam and the counted leaves
  spread over decades of each branch's **rarest pair** when the window is open at either end, because
  ranking alone pulls an unaimed walk to the rare end and a branch never kept can never be counted —
  without it an *Any rarity* board fills far fewer cards than it declares. `shuffleHead` takes the shortlist
  and the board from a shuffled head of what the search considered. `pickSpreadBoard` deals a board **round
  robin across the bands it found**, so the balance is inside page 1. Pages are still slices of that one
  board; `found` and every card's `count` are untouched; the same seed replays the same board. The gap sweep
  is exempt from the spread — it cost nearly half the gaps it finds.
- `seed` is honoured by `scan`, `draft/tags` and `draft/draw`: same seed, same answer — a cheap regression
  check. `/api/draw` has no seed: a crate press is meant to surprise.
- `SCAN_DEBUG=1` (or `globalThis.SCAN_DEBUG = 1` in a browser console) prints per-scan stats.

## HTTP surface (`engine.js`)

Tag arguments are **numeric Steam tag ids only** (`?tags=19,1685`, `?must=19`); names resolve only through
`/api/tags?q=` (fuzzy: `coop` → `Co-op`), and a name in `?tags=` is dropped silently. **The page never calls
these routes** — `local-api.js` invokes the same handlers in-process — but they are the curl surface for
hand-checks, and all are read-only (`POST`/`DELETE` → `404 {"error": "…"}`; `local-api.js` re-throws the same
message with `.status`). Do not add a query parameter with no control behind it: the four panels are the
product's surface.

| Route | Parameters |
| --- | --- |
| `/api/meta` | counts, `indexed_ms`, `catalog`, `last_sync`, `saved_spaces` (counted by whoever answers — the browser, on the page), `tiers`, `band_gaps`, `cases` |
| `/api/tags` | `q` (case- and punctuation-insensitive substring, ranked exact > prefix > substring), `limit` ≤500 (default 40); `Tag_*` placeholders skipped |
| `/api/combo` | `tags`, `limit` ≤100, `offset`, `variants=1`; answers `{ combo, unresolved }` |
| `/api/games` | `tags`, `limit` ≤200, `offset` — most reviewed first |
| `/api/suggest` | `tags`, `mode=rarest\|potential\|audience`, `limit` ≤40, `minCount`, `maxCount` |
| `/api/scan` | `must`, `k` 2–5, `minCount`, `maxCount`, `includeEmpty=1`, `rankBy=potential\|rarest\|audience\|random`, `limit` ≤60, `offset`, `board` ≤200 (**repeat on every page**), `gamesPerSpace` 0–12 (Finder 4, Missed 2), `thoroughness` 1–3 (omitted → `AUTO_DEPTH`), `emptyFloor` 1–50000 (echoed as `empty_floor`), `seed`, the rarity window — and nothing else. Payload adds `board_total`; `found` = complete mixes enumerated before the shortlist, `spaces` = the page |
| `/api/draw` | `k`, `case`, `bias=balanced\|seeker\|magnet`, `forceBand` (any id, `empty` included), `avoid=a;b`; no seed |
| `/api/cases` | crate definitions |
| `/api/draft/tags` | `case`, `shown` 6–20, `k` 2–5, `seed`, `disabled`. **The page sends no `case`**: a draft pool is dealt from every catalogued tag |
| `/api/draft/draw` | as `draft/tags` plus `bias`, `forceBand`, `avoid` |
| static (local) | `public/` only, path-guarded; `Cache-Control: no-store` for HTML, 5 min otherwise — hard-refresh after editing the client |

## Testing

No test suite; this replaces one. The catalog file is the bench: work on a **copy**, never let a test write
the committed one.

```bash
cp public/data/catalog.bin.gz .probe/copy.bin.gz
node scripts/check-catalog.js --snapshot .probe/copy.bin.gz              # battery + invariant
node scripts/update-snapshot.js --in .probe/copy.bin.gz --out .probe/probe.bin.gz --limit 40 --no-backup
node scripts/check-catalog.js --snapshot .probe/probe.bin.gz             # what came back
PORT=8791 node server/server.js                                          # the page + curl, on the real file
node scripts/update-snapshot.js --in .probe/copy.bin.gz --dry-run 20     # first check after a scraper change
```

Expect `[invariant] … OK` and `25 of 25 queries answered from …`. `--dry-run` prints name, tag count,
reviews and release date per page; `reviews —` means the selectors went stale. A truncated file prints the
partial-catalog note and band coverage by length, and greyed bands, empty `spaces` at `k≥4` and
`landed_other_tier: true` are correct there, not bugs.

Then curl every route above, including `POST /api/spaces` answering `404`, and press the page at
`http://127.0.0.1:8791/` (a scratch CDP probe under `.probe/` presses all of it). What has to be true:

- A card's `count` equals `/api/games?tags=<those ids>`' `total`; a window's `found` equals a count straight
  over the pair array (100–499 → 15,948; ≥ 10,000 → 250); two blank sweeps at different `offset`s report the
  same `found` and `board_total`, no card twice, and echo `empty_floor`.
- Boards page 24 at a time in the Finder and 12 in Missed, each page appended **before** the pill, no
  combination twice in the walk, no pill on a board shorter than a page, and the stat line stays complete
  from the second page on.
- Two presses with the same settings share no cards (Finder `k=3` *Any rarity*, Missed `k≥3`); with one `seed`
  sent twice the board is identical, and pages of one press never repeat a card.
- An open rarity window fills the board it declares and shows several bands on one page; a window naming one
  band answers with only that band.
- The eleven options carry the same values in all three panels, the select moves the gold legend rows, an
  unreachable band is greyed with its reason, and *Guarantee empty* lands on an Empty badge with the gap note.
- A press greys the panel that answered it (`is-busy`, `aria-busy="true"`, the button naming the work, every
  control that could start a second job disabled) and everything is pressable again afterwards, with no
  control moving. Board pages and a card's pill grey themselves.
- Chips pin one tag each and never search on their own; jump buttons read **Search this combination** with
  the Finder tab open and **Open in Finder** elsewhere; a saved row grows its games with the same pill. On
  touch, a second tap on a chip takes the tag out and drops the gold at once.
- `document.documentElement.scrollWidth` equals `clientWidth` at 1440, 1240, 1024, 900, 760, 640, 560, 430,
  390, 320 — saved panel open, all four tabs, after a search with long titles. Use `clientWidth`, not
  `innerWidth`: headless Chrome's classic scrollbar eats ~15 px of `innerWidth`. Pressing Search does not
  move the buttons.

**Cleanup:** delete what a session leaves under `.probe/`, including `*.bin.gz`. A refresh of the **real**
file keeps the bytes it replaced in `backups/`, ~7 MB each and never pruned — use `--no-backup` for tests.

## Environment

| Name | Default | Read by |
| --- | --- | --- |
| `PORT` | `8787` | `server.js` — use a spare port when testing, so you never collide with a running instance |
| `HOST` | `127.0.0.1` | `server.js` — keep it; `0.0.0.0` exposes `/api/meta`, which names the catalog file |
| `SCAN_DEBUG` | unset | `combos.js` — per-scan stats; `globalThis.SCAN_DEBUG = 1` in a browser console |

That is the whole surface. `update-snapshot.js` takes flags, not environment, and a missing
`public/data/catalog.bin.gz` stops the server at boot with the command to restore it.

## Steam drift and gotchas

- **Review figures come from two places on a page:** `<meta itemprop="reviewCount">` and the sentence
  `93% of the 71,567 user reviews for this game are positive` (`parseReviewFigures` prefers the "for this
  game" one over the 30-day one). The public `appreviews` endpoint 302-redirects cookie-less callers, so
  `fetchReviewSummary` is a last resort. Drift shows as `--dry-run 20` printing `reviews —`.
- **A catalog can lose its review figures quietly:** a page parsed with stale selectors keeps names, tags and
  dates and drops the numbers, and nothing looks wrong. Ask the index
  (`[...store.reviewsOf].filter(n => n >= 0).length`) and backfill in slices with
  `npm run update-snapshot -- --refresh N`.
- Steam's tag pages include DLC, bundles and demos; this catalog is the **app list filtered to base games**,
  so counts here do not match Steam's tag page — which is also why a saved combination's count can drop after
  an update, when a game leaves the app list.
- `?l=english` on every fetch, or tag names come back localized and the dictionary duplicates them. A couple
  of dozen of 196,542 ids are age-gated and simply absent; that surfaces as counted errors, not crashes.
- **A client module can lose an import and still boot.** With no build and no tests, a missing `import`
  surfaces as a `ReferenceError` the first time that path runs. Exercise the feature after editing a client
  module. The browser caches the client for 5 minutes, so a panel behaving the old way is usually the old
  module still in memory.

## Conventions

- Everything about the file **format** lives in `snapshot.js`. A second parser is how a catalog becomes
  unreadable.
- Crawling stays polite: `--limit` bounds a run, the default pacing stays, tests point at a scratch copy.
- Copy, band names and crate blurbs live in the client and in `tiers.js` / `CASES`, so README wording changes
  with them. README copy describes; it does not argue.
- New panels reuse `.console-*`, the chip path, the legend blocks and `paintMoreControl`. Hand-rolling any of
  those is a regression.
- **`docs/img/` is the README's seven screenshots** (`wordmark`, `finder`, `card`, `crate`, `draft`, `missed`,
  `saved`). A change to layout, a control's label, stat-line wording or a band colour makes the affected one
  stale, so re-shoot the set together at 1440px against `npm start` reading the published file. `wordmark.png`
  comes from a scratch page outside the repository — ask the human to re-author it. **`public/favicon.svg` is
  the only icon**; judge a change at 16px.
- The project's purpose is curiosity about game *ideas*: do not steer it toward generating game content,
  scaffolding projects, or business or market analysis.
- Change behaviour → update README and AGENTS.md in the same pass, and keep this file under 65,536 bytes.
