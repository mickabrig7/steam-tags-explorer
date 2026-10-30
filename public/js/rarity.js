/* The Rarity control — one select, shared by the Finder, the random draw and the draft pick.

   Every mode offers the same options in the same words: **Any rarity**, **Prioritize rare**,
   **Prioritize common**, then **Guarantee <band>** for every band the catalog can put a mix in —
   `empty` included, in all three panels. Only what the option *does* changes between modes:

   | value                 | the Finder does                       | a draw does                    |
   | ---                   | ---                                   | ---                            |
   | `any`                 | no window at all                      | weight the roll evenly         |
   | `lean_rare`           | only mixes in the rare half (0–99)    | `bias=seeker`                  |
   | `lean_common`         | only mixes in the common half (100+)  | `bias=magnet`                  |
   | a band id             | `minCount`/`maxCount` = that band     | `forceBand=<band id>`          |

   A search has no random draw to bias, so in the Finder the two “prioritize” entries are
   hard windows: that is the only honest way to lean a board of results. A draw does the
   opposite — it keeps the whole range and tilts the roll, unless it commits to one band.
   `Guarantee empty` is a window (0 to 0 games) in the Finder and a band the roll has to land
   in anywhere else. Nothing on the page asks whether a gap is *interesting*: the search
   answers a 0-to-0 window inside the pool of tags popular enough to be worth asking about
   (`emptyFloor`, whose server default the payload echoes as `empty_floor`), and a draw rolls
   over a tag pool wide enough that gaps far outnumber the pairs in it.
   The band names in the options are the same words as the rarity block beside the control
   (`ui.js rarityLegend`), which is why neither the options nor the notes spell out counts.
*/

import { clear, el, fmtInt } from './ui.js';

export const RARITY_ANY = 'any';
export const RARITY_LEAN_RARE = 'lean_rare';
export const RARITY_LEAN_COMMON = 'lean_common';

/**
 * "No ceiling", as a number the search accepts. The busiest *pair* in a finished
 * catalog is well under a hundred thousand games, and every longer mix is rarer than
 * its pairs, so nothing in the catalog is excluded by asking for this.
 */
export const NO_CEILING = 1_000_000;

/**
 * Where the two “prioritize” entries cut the range: `Rare` (25–99) is the common end
 * of the rare half, `Uncommon` (100–499) the rare end of the commoner half.
 */
const RARE_HALF_MAX = 99;
const COMMON_HALF_MIN = 100;

const LEAN_LABEL = {
  [RARITY_LEAN_RARE]: 'Prioritize rare',
  [RARITY_LEAN_COMMON]: 'Prioritize common',
};

/**
 * The halves in the stat line’s words, named by the bands they hold: the rarity block beside
 * the control already lists those bands and their ranges, so the note does not repeat them.
 */
function leanNote(value, tiers) {
  const rare = value === RARITY_LEAN_RARE;
  const half = rarityBands(tiers)
    .filter((t) => (rare ? t.min <= RARE_HALF_MAX : t.min >= COMMON_HALF_MIN));
  if (!half.length) return '';
  return ` · ${half[0].name} to ${half[half.length - 1].name} only`;
}

/**
 * The bands this control can offer: every one of them, in every mode. A gap is a real answer
 * everywhere — the Missed opportunities panel is dedicated to it, a Finder window can ask for
 * one, and a draw can land on one — so all three panels offer the same list.
 */
export function rarityBands(tiers) {
  return tiers || [];
}

/** The count window a band means, in the numbers the search speaks. */
export function bandWindow(tier) {
  return { min: tier.min, max: tier.max == null ? NO_CEILING : tier.max };
}

/**
 * A count window in the shape the rarity block uses for its ranges — `0 games`, `1–4 games`,
 * `10,000+ games` — so the numbers in a note and the numbers in the block are the same numbers.
 */
export function windowRangeText(window) {
  const min = Number(window.minCount) || 0;
  const max = Number(window.maxCount);
  if (min === 0 && max === 0) return '0 games';
  if (max >= NO_CEILING) return `${fmtInt(min)}+ games`;
  if (min === max) return `${fmtInt(min)} games`;
  return `${fmtInt(min)}–${fmtInt(max)} games`;
}

export function rangeText(tier) {
  const w = bandWindow(tier);
  return windowRangeText({ minCount: w.min, maxCount: w.max });
}

/** The words on one band option: it promises that band, in the table’s own names. */
export function rarityOptionLabel(tier) {
  return `Guarantee ${tier.name.toLowerCase()}`;
}

/**
 * Fill the select — the same option list in every mode. The game counts live in the rarity
 * block beside the control and one hover away in the option’s title, so the option text stays
 * short. The plain label is kept on the option so availability can restore it.
 */
export function fillRarity(select, tiers) {
  clear(select);
  select.append(el('option', { value: RARITY_ANY, text: 'Any rarity', title: 'Every band, no window.' }));
  for (const value of [RARITY_LEAN_RARE, RARITY_LEAN_COMMON]) {
    const title = value === RARITY_LEAN_RARE
      ? windowRangeText({ minCount: 0, maxCount: RARE_HALF_MAX })
      : windowRangeText({ minCount: COMMON_HALF_MIN, maxCount: NO_CEILING });
    select.append(el('option', { value, text: LEAN_LABEL[value], title }));
  }
  for (const tier of rarityBands(tiers)) {
    const text = rarityOptionLabel(tier);
    const option = el('option', { value: tier.id, text, title: tier.blurb || rangeText(tier) });
    option.dataset.label = text;
    select.append(option);
  }
  select.value = RARITY_ANY;
}

/**
 * Grey out the bands this control cannot offer and rename the option so the reason sits
 * in the control rather than in a paragraph next to it. `missing` is band ids — from
 * `/api/meta`'s `band_gaps` for a mix length, or from the pool census for a draft.
 * Returns the band that had to be given up because it was the one selected, else null.
 */
export function applyRarityAvailability(select, tiers, missing, reasonFor) {
  const bands = new Map(rarityBands(tiers).map((t) => [t.id, t]));
  const gone = new Set(missing || []);
  for (const option of select.options) {
    const tier = bands.get(option.value);
    if (!tier) continue;
    const blocked = gone.has(tier.id);
    option.disabled = blocked;
    option.textContent = blocked ? reasonFor(tier) : option.dataset.label;
  }
  if (!gone.has(select.value)) return null;
  const dropped = bands.get(select.value) || null;
  select.value = RARITY_ANY;
  return dropped;
}

/** The window of catalog counts a search must answer inside, as API params. */
export function rarityWindow(value, tiers) {
  if (value === RARITY_LEAN_RARE) return { minCount: 0, maxCount: RARE_HALF_MAX, includeEmpty: 1 };
  if (value === RARITY_LEAN_COMMON) return { minCount: COMMON_HALF_MIN, maxCount: NO_CEILING };
  const tier = (tiers || []).find((t) => t.id === value);
  if (tier) {
    const w = bandWindow(tier);
    return { minCount: w.min, maxCount: w.max };
  }
  return { minCount: 0, maxCount: NO_CEILING, includeEmpty: 1 };
}

/** How a draw honours the same value: a tilt of the roll, or a band it has to land in. */
export function rarityDraw(value) {
  if (value === RARITY_LEAN_RARE) return { bias: 'seeker' };
  if (value === RARITY_LEAN_COMMON) return { bias: 'magnet' };
  if (value && value !== RARITY_ANY) return { bias: 'balanced', forceBand: value };
  return { bias: 'balanced' };
}

/** Does this value pin the answer to one band? (A draft says so when its pool cannot keep it.) */
export function rarityIsGuarantee(value) {
  return Boolean(value) && value !== RARITY_ANY
    && value !== RARITY_LEAN_RARE && value !== RARITY_LEAN_COMMON;
}

/** The same value in the shorter words the stat line uses: a note, not a sentence. */
export function rarityNote(value, tiers) {
  if (!value || value === RARITY_ANY) return '';
  if (LEAN_LABEL[value]) return leanNote(value, tiers);
  const tier = (tiers || []).find((t) => t.id === value);
  return tier ? ` · ${rarityOptionLabel(tier)}` : '';
}

/**
 * A search window and one exact combination are two different questions: the combination
 * already has its count, and it does not move because the control asks for another band.
 * So when the Finder is pointed at a single combination, the stat line reports the window as
 * the thing this answer falls outside, rather than pretending it applied.
 */
export function rarityMismatch(value, tiers, count) {
  if (!value || value === RARITY_ANY) return '';
  const w = rarityWindow(value, tiers);
  if (count >= w.minCount && count <= w.maxCount) return '';
  const tier = (tiers || []).find((t) => t.id === value);
  const band = tier
    ? tier.name.toLowerCase()
    : value === RARITY_LEAN_RARE ? 'the rare half' : 'the common half';
  return ` · outside ${band} (${windowRangeText(w)})`;
}

/**
 * Which rows of the rarity block this choice speaks for. The ranges come off the rows themselves
 * (their `data-min`/`data-max`, written from `/api/meta`), so the mark can never disagree with the
 * server's bands and the client holds no copy of a threshold.
 *
 * - A **guarantee** covers exactly its band, and nothing else can be handed back.
 * - A **prioritize** entry covers the half it names, and the same half in every panel: that range
 *   is what a Finder search filters to and what a crate or a draft rolls inside. *Prioritize rare*
 *   reaches 0 games, so its block lights the Empty row - a press under it can come out a
 *   combination no catalogued game carries.
 * - **Any rarity** covers every row, so it marks nothing: gold means "this choice cannot take you
 *   anywhere else", and a block lit end to end would say nothing at all.
 */
function coveredBands(rows, value) {
  if (rarityIsGuarantee(value)) return new Set([value]);
  if (value !== RARITY_LEAN_RARE && value !== RARITY_LEAN_COMMON) return new Set();
  const rare = value === RARITY_LEAN_RARE;
  const covered = new Set();
  for (const row of rows) {
    const min = Number(row.dataset.min) || 0;
    const max = row.dataset.max === '' || row.dataset.max == null ? null : Number(row.dataset.max);
    const inHalf = rare ? max !== null && max <= RARE_HALF_MAX : min >= COMMON_HALF_MIN;
    if (inHalf) covered.add(row.dataset.band);
  }
  return covered;
}

/**
 * Light up the rows of the rarity block this choice covers - one row for a guarantee, four for a
 * prioritize entry, none for "Any rarity". Every panel marks the same rows for the same choice.
 */
export function markRarityLegend(host, value) {
  if (!host) return;
  const rows = Array.from(host.querySelectorAll('[data-band]'));
  const covered = coveredBands(rows, value);
  for (const row of rows) row.classList.toggle('is-on', covered.has(row.dataset.band));
}
