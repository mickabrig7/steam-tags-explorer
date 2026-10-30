/* Mode 1 — Finder: pick tags, choose how many to combine and which rarity to answer inside. */

import { api } from './local-api.js';
import { addSelected, openInFinder, removeSelected, selectedTags, setSelected } from './main.js';
import { clear, comboCard, el, emptyState, fmtCompact, fmtInt, nextFrame, paintMoreControl, plural, setBusy, spinner } from './ui.js';
import {
  applyRarityAvailability, fillRarity, markRarityLegend, NO_CEILING, rarityMismatch,
  rarityNote, rarityWindow,
} from './rarity.js';
import { uiBlip } from './sound.js';
import { scrollToInterest } from './fx.js';
import { comboJumpAction, saveAction } from './vault.js';

const els = {
  input: document.getElementById('tagInput'),
  suggest: document.getElementById('tagSuggest'),
  k: document.getElementById('finderK'),
  legend: document.getElementById('legendRarityFinder'),
  rarity: document.getElementById('finderRarity'),
  go: document.getElementById('finderGo'),
  clearBtn: document.getElementById('finderClear'),
  stat: document.getElementById('finderStat'),
  results: document.getElementById('finderResults'),
  panel: document.querySelector('.console-finder'),
};

/**
 * Page and board size. A page is a reading length rather than a search setting: 24 cards
 * of four games each is roughly four screens, and the rest of the board arrives under a
 * “Show N more combinations” button. The client declares the whole board once (`board`
 * below) and repeats it on every page, which is what keeps the pages slices of one ranked
 * list rather than separate rolls that happen to overlap. `MAX_BOARD` in
 * `public/engine/combos.js` is the ceiling the search will accept.
 */
const PAGE = 24;
const BOARD = PAGE * 3;

let suggestTimer = null;
let suggestItems = [];
let activeIndex = -1;
let runSeq = 0;
let searched = false;
// The roll for the current search: paging re-asks with the same seed, so a later
// page is the tail of the board this one came from. Pressing Search starts a new roll.
let runSeed = 0;
/** The board the current search built: `{ params, rarity, host, seq, shown, total, kept }`. */
let board = null;

/* ------------------------------ tag autocomplete --------------------------- */

function paintSuggest(items) {
  clear(els.suggest);
  els.suggest.hidden = items.length === 0;
  suggestItems = items;
  activeIndex = -1;
  items.forEach((tag, index) => {
    const row = el('li', { dataset: { index: String(index) } }, [
      el('span', { text: tag.name }),
      el('span', { className: 'count', text: `${fmtCompact(tag.games)} games` }),
    ]);
    row.addEventListener('mousedown', (event) => {
      event.preventDefault();
      pickTag(tag);
    });
    els.suggest.append(row);
  });
}

function pickTag(tag) {
  addSelected(tag);
  els.input.value = '';
  paintSuggest([]);
  uiBlip();
  if (searched) els.stat.textContent = 'Tags changed. Press “Search combinations”.';
}

function searchTags() {
  const q = els.input.value.trim();
  if (suggestTimer) clearTimeout(suggestTimer);
  if (q.length < 2) {
    paintSuggest([]);
    return;
  }
  suggestTimer = setTimeout(async () => {
    try {
      const out = await api.tags(q, 10);
      const picked = new Set(selectedTags().map((t) => t.id));
      paintSuggest((out.tags || []).filter((t) => !picked.has(t.id)));
    } catch {
      paintSuggest([]);
    }
  }, 180);
}

function moveActive(delta) {
  if (!suggestItems.length) return;
  const rows = [...els.suggest.querySelectorAll('li')];
  activeIndex = (activeIndex + delta + suggestItems.length) % suggestItems.length;
  rows.forEach((row, i) => row.classList.toggle('is-active', i === activeIndex));
}

/* --------------------------------- controls -------------------------------- */

/** The bands and where the catalog cannot reach them, both from `/api/meta`. */
let tiers = [];
let bandGaps = {};

/**
 * Grey out the bands this mix length cannot land in, and say so in the option itself —
 * a board that comes back empty because the window is impossible reads like a broken
 * search. `band_gaps` is a fact about the catalog (`bandAvailability` in `public/engine/combos.js`).
 * Returns the sentence explaining a band the reader had already chosen, else an empty string.
 */
function syncRarityAvailability() {
  const k = Number(els.k.value) || 3;
  const dropped = applyRarityAvailability(
    els.rarity,
    tiers,
    bandGaps[k] || [],
    (tier) => `${tier.name}: not possible with ${k} tags`,
  );
  if (!dropped) return '';
  return `No combination of ${k} tags reaches ${fmtInt(dropped.min)} ${dropped.min === 1 ? 'game' : 'games'} in this catalog. Choose a lower band, or fewer tags.`;
}

function mixSize(pickedCount) {
  const wanted = Number(els.k.value) || 3;
  // You cannot build a 3-tag mix out of 4 chosen tags, so the mix size follows the pick.
  return Math.max(wanted, pickedCount, 2);
}

/** The longest mix the control offers: the markup owns the ceiling, so the page can never
 *  ask for a length the search does not answer. */
function maxMixSize() {
  const options = els.k.options;
  return Number(options[options.length - 1].value) || 5;
}

function syncMixSize(pickedCount) {
  const size = mixSize(pickedCount);
  if (Number(els.k.value) !== size) {
    els.k.value = String(Math.min(size, maxMixSize()));
  }
  return Number(els.k.value);
}

/* ----------------------------------- run ---------------------------------- */

async function run() {
  const picked = selectedTags().map((t) => t.id);
  const k = syncMixSize(picked.length);
  const seq = ++runSeq;
  // A press of Search starts a new roll: the board it ranks uses this seed, and every
  // page of that board asks for the same one.
  runSeed = Math.floor(Math.random() * 1e9) || 1;
  board = null;

  // The spinner goes inside the results host: replacing the host node would detach
  // it, and the results would then render into a node that is no longer in the page.
  clear(els.results).append(spinner(picked.length ? 'Searching this combination…' : 'Searching the catalog…'));
  // A press of Search is a request to see the answer, so the board comes to the reader instead of
  // the reader hunting for it — and only when it is genuinely off screen. Paging a board that is
  // already open never calls this, so nothing moves under a reader who is working down a list.
  scrollToInterest(els.results);
  els.stat.textContent = '';
  // Everything that could start a second search goes grey, and the frame is waited for: the search
  // itself blocks this thread (the engine answers in-process), so a phone would otherwise sit on a
  // second unchanged screen. The tag box stays editable — typing during a search is harmless, and
  // the line already says what will make the board agree again.
  const stop = setBusy(els.panel, { button: els.go, label: 'Searching…', disable: [els.clearBtn, els.k, els.rarity] });
  await nextFrame();

  try {
    if (picked.length === k && picked.length > 0) {
      await runExact(picked, { k, seq });
    } else {
      await runScan(picked, { k, seq });
    }
    if (seq === runSeq) searched = true;
  } catch (err) {
    if (seq !== runSeq) return;
    clear(els.results).append(emptyState(err.message, true));
    els.stat.textContent = 'The search failed.';
  } finally {
    // A newer press owns the grey from then on, so an old answer arriving late must not lift it.
    if (seq === runSeq) stop();
  }
}

/** The exact mix is known: show its rarity, its games, and the two directions to stretch it. */
async function runExact(ids, { k, seq }) {
  const [combo, rarer, hotter] = await Promise.all([
    api.combo(ids, { limit: 12, variants: true }),
    api.suggest(ids, { mode: 'rarest', limit: 6 }),
    api.suggest(ids, { mode: 'audience', limit: 6 }),
  ]);
  if (seq !== runSeq) return;

  const host = clear(els.results);
  const summary = combo.combo || combo;
  host.append(comboCard(summary, {
    hero: true,
    onTagClick: toggleFilterTag,
    pickedIds: tagIsPicked,
    onAction: cardActions(summary),
    onLoadMore: moreGamesFor(summary),
  }));

  const stretch = el('div', { className: 'variants' });
  const rarerItems = rarer.suggestions || [];
  const hotterItems = hotter.suggestions || [];
  if (rarerItems.length) {
    stretch.append(el('span', { className: 'tier-blurb', text: 'Rarer with one more tag:' }));
    for (const item of rarerItems) stretch.append(variantButton(item, seq));
  }
  if (hotterItems.length) {
    stretch.append(el('span', { className: 'tier-blurb', text: 'More played with one more tag:' }));
    for (const item of hotterItems) stretch.append(variantButton(item, seq));
  }
  if (stretch.children.length) host.append(stretch);

  // One exact combination is one answer, not a board, so the rarity window says what it
  // would have done rather than pretending it shaped this card.
  const count = Number(summary.count) || 0;
  els.stat.textContent =
    `${k} tags · ${fmtInt(count)} ${plural(count, 'game')} in the catalog`
    + rarityMismatch(els.rarity.value, tiers, count);
}

function variantButton(item, seq) {
  const tag = item.tag || item;
  const count = Number(item.count ?? item.games_with ?? 0);
  const btn = el('button', {
    className: 'mini-btn',
    type: 'button',
    text: `+ ${tag.name} (${fmtInt(count)} games)`,
    title: count === 0
      ? `Add ${tag.name}. The longer combination has no games in the catalog.`
      : `Add ${tag.name}. The longer combination has ${fmtInt(count)} games in the catalog.`,
  });
  btn.addEventListener('click', () => {
    addSelected({ id: tag.id, name: tag.name, games: tag.games });
    uiBlip();
    run();
  });
  return btn;
}

/** Search for mixes of `k` tags, optionally pinned to the tags already picked. */
async function runScan(picked, { k, seq }) {
  const params = {
    k,
    must: picked.length ? picked.join(',') : undefined,
    rankBy: 'random',
    limit: PAGE,
    board: BOARD,
    gamesPerSpace: 4,
    seed: runSeed,
    // A press picks at random from what the search found, so the board is a sample rather
    // than a ranking. The window is what bounds it, and the rarity block beside the control
    // says what that window means. The counts in the stat line stay exact either way.
    ...rarityWindow(els.rarity.value, tiers),
  };
  const out = await api.scan(params);
  if (seq !== runSeq) return;

  const host = clear(els.results);
  const spaces = out.spaces || [];
  board = {
    params,
    rarity: els.rarity.value,
    host,
    seq,
    total: Number.isFinite(out.board_total) ? out.board_total : spaces.length,
    shown: spaces.length,
  };
  if (!spaces.length) {
    host.append(emptyState('Nothing matched at this size'
      + (params.minCount > 0 || params.maxCount < NO_CEILING ? ' in the rarity you chose' : '')
      + '. Try a wider rarity, or fewer tags.'));
  }
  for (const space of spaces) host.append(scanCard(space));
  paintBoardMore();

  els.stat.textContent = scanStat(out);
}

function scanCard(space) {
  return comboCard(space, {
    onTagClick: toggleFilterTag,
    pickedIds: tagIsPicked,
    // The nearest combinations on a blank card are whole combinations, so one click puts that
    // whole set in the tag box — and stops there. The card's own **Search this combination**
    // button is the one that searches, because there the combination is the question being asked.
    onNeighbor: (tags) => {
      openInFinder(tags, { run: false });
      uiBlip();
      if (searched) els.stat.textContent = 'Tags changed. Press “Search combinations”.';
    },
    onAction: cardActions(space),
    onLoadMore: moreGamesFor(space),
  });
}

/**
 * The control under the board: the next page of this same search, with the same seed, read out of
 * the same ranked list. It comes from `ui.js paintMoreControl`, the one implementation behind every
 * list this page grows — it only exists while results are being held back, it says how many are
 * left, and it disappears when the board runs out — so the pill under a board and the one under a
 * card's games can never drift apart.
 */
function paintBoardMore() {
  if (!board) return;
  // The pill belongs to one board. Capture it: a page still in flight when a new search starts
  // must not append its cards to the new board, however fresh the module-level `board` looks by
  // then. Handing back null is the search's way of saying "that board is gone".
  const mine = board;
  paintMoreControl(mine.host, mine, {
    pageSize: PAGE,
    unit: 'combination',
    pending: 'Searching…',
    render: scanCard,
    load: async (offset) => {
      if (mine !== board || mine.seq !== runSeq) return null;
      const out = await api.scan({ ...mine.params, offset });
      if (mine !== board || mine.seq !== runSeq) return null;
      // The page's own payload rides along with its cards: a page is a re-run of this search, and the
      // line under the buttons reports what *that* run counted. Handing back only `items` and `total`
      // here left the line reading `found — · scanned — · — ms` from the second page on.
      return { ...out, items: out.spaces || [], total: out.board_total };
    },
    onLoaded: (out) => { els.stat.textContent = scanStat(out); },
  });
}

/**
 * The line under the buttons: number facts about what the search did, then where the reader stands
 * in the answer. `found` is every combination the search counted, `on board` how many of them a
 * board this width can hand out, `shown` how many are on screen now.
 */
function scanStat(out) {
  const k = board.params.k;
  const rarity = board.rarity;
  const pinned = selectedTags().map((t) => t.id);
  return `${k} tags · found ${fmtInt(out.found)} · on board ${fmtInt(board.total)} · shown ${fmtInt(board.shown)}`
    + ` · scanned ${fmtCompact(out.scanned_candidates)} candidates · ${fmtInt(out.ms)} ms`
    + rarityNote(rarity, tiers)
    // A guaranteed gap is searched among tags with a real audience, not across every tag in
    // the catalog — the payload says which floor it used, so the line can say it too.
    + (rarity === 'empty' ? ` · pool ${fmtInt(out.pool_size)} tags ≥ ${fmtInt(out.empty_floor)} games` : '')
    + (out.cached ? ' · cached' : '')
    + (pinned.length ? ` · pinned: ${pinned.map((id) => nameOf(id)).join(' + ')}` : '');
}

function nameOf(id) {
  const known = selectedTags().find((t) => t.id === id);
  return known ? known.name : `tag ${id}`;
}

/* -------------------------------- card actions ----------------------------- */

/**
 * A card offers two things: ask about this exact combination, and keep it. Both buttons come from
 * the saved panel (`comboJumpAction` and `saveAction`), so a card in the Finder and a card in a
 * draw carry the same pair with the same behaviour. The jump button reads **Search this
 * combination** here, because the reader is already in the Finder and there is no Finder left to
 * open. The tags on the card are already the way in or out of the tag box, so there is no separate
 * "add these tags" button, and the games under the card reach the rest of their list themselves.
 */
function cardActions(space) {
  return [comboJumpAction(space), saveAction(space)];
}

/** Whether a tag is in the tag box right now — asked live, so a card's chips stay honest. */
function tagIsPicked(tag) {
  return selectedTags().some((t) => t.id === tag.id);
}

/**
 * A tag on a card is a filter you can switch on or off, and switching it is all a click
 * does. The board changes when the reader presses “Search combinations”: a click on a
 * tag is not a request to draw a fresh random pick while they are still reading this one.
 */
function toggleFilterTag(tag) {
  const picked = selectedTags();
  if (picked.some((t) => t.id === tag.id)) {
    removeSelected(tag);
  } else if (picked.length >= maxMixSize()) {
    els.stat.textContent = `A combination holds at most ${maxMixSize()} tags. Take one out before adding ${tag.name}.`;
    return;
  } else {
    addSelected({ id: tag.id, name: tag.name, games: tag.games });
  }
  uiBlip();
  if (searched) els.stat.textContent = 'Tags changed. Press “Search combinations”.';
}

/** The loader behind a card's “Show N more games”: the rest of this combination's games. */
function moreGamesFor(space) {
  const ids = (space.tags || []).map((t) => t.id);
  return (offset, limit) => api.games(ids, { limit, offset });
}

/* --------------------------------- wiring ---------------------------------- */

export function initFinder(ctx) {
  els.input.addEventListener('input', searchTags);
  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeIndex >= 0 && suggestItems[activeIndex]) pickTag(suggestItems[activeIndex]);
      else if (els.input.value.trim().length >= 2) {
        api.tags(els.input.value.trim(), 1).then((out) => {
          if (out.tags && out.tags[0]) pickTag(out.tags[0]);
          else els.stat.textContent = `no tag named "${els.input.value.trim()}"`;
        });
      } else {
        run();
      }
    } else if (event.key === 'Escape') {
      paintSuggest([]);
    }
  });

  els.go.addEventListener('click', () => {
    uiBlip();
    run();
  });
  els.clearBtn.addEventListener('click', () => {
    setSelected([]);
    els.input.value = '';
    paintSuggest([]);
    clear(els.results).append(emptyState('Tags cleared.'));
    els.stat.textContent = '';
    searched = false;
  });

  for (const node of [els.k, els.rarity]) {
    node.addEventListener('change', () => {
      // A setting change on its own does nothing: only the search button starts a search.
      let note = '';
      if (node === els.k) {
        syncMixSize(selectedTags().length);
        note = syncRarityAvailability();
      }
      markRarityLegend(els.legend, els.rarity.value);
      uiBlip();
      if (note) els.stat.textContent = note;
      else if (searched) els.stat.textContent = 'Settings changed. Press “Search combinations”.';
    });
  }

  window.addEventListener('steamtage:run-finder', () => run());
  window.addEventListener('steamtage:view', (event) => {
    if (event.detail.view === 'finder') els.input.focus({ preventScroll: true });
  });
  // The tag box changed somewhere else on the page — a chip on a card in another mode, or a row in
  // the saved panel. That does not redraw the board, and it should not, so the line says what
  // changed and what will make the board agree with it again. `note` asks for other words: the one
  // case being a tag box that is already full.
  window.addEventListener('steamtage:tags', (event) => {
    const note = event.detail && event.detail.note;
    if (note) {
      els.stat.textContent = note;
      return;
    }
    if (searched) els.stat.textContent = 'Tags changed. Press “Search combinations”.';
  });

  return {
    ready() {
      // The band names, their ranges and where the catalog cannot reach them all come from
      // the server, so a partial catalog greys out the right things instead of lying.
      tiers = ctx.tiers || (ctx.meta && ctx.meta.tiers) || [];
      bandGaps = (ctx.meta && ctx.meta.band_gaps) || {};
      fillRarity(els.rarity, tiers);
      syncRarityAvailability();
      markRarityLegend(els.legend, els.rarity.value);
      clear(els.results).append(emptyState('Nothing searched yet. Press “Search combinations”.'));
      els.input.focus({ preventScroll: true });
    },
    run,
  };
}
