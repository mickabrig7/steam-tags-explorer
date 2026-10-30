/* Mode 3 — Missed opportunities: the spaces on the tag map that no game occupies yet, and
   that a popular crowd of tags would lead somewhere. The radar sweep finds combinations whose
   tags are used by crowds of games but whose crowds never met; what you save from them goes to
   the saved panel on the right, like every other mode. The tab's id is `uncharted`, and the
   server's own word for the mode is `blankOnly`. */

import { api } from './local-api.js';
import { openInFinder, selectedTags, toggleTagInFinder } from './main.js';
import { clear, comboCard, emptyState, fmtInt, nextFrame, paintMoreControl, setBusy, spinner } from './ui.js';
import { markRarityLegend } from './rarity.js';
import { celebrate, motionAllowed, scrollToInterest } from './fx.js';
import { uiBlip } from './sound.js';
import { comboJumpAction, saveAction } from './vault.js';

const els = {
  k: document.getElementById('spaceK'),
  floor: document.getElementById('spaceFloor'),
  go: document.getElementById('spaceGo'),
  stat: document.getElementById('spaceStat'),
  radar: document.getElementById('radar'),
  results: document.getElementById('spaceResults'),
  legend: document.getElementById('legendRaritySpace'),
  panel: document.getElementById('view-uncharted').querySelector('.console'),
};

/**
 * One order, and deliberately not a control. An empty combination has no reviews and no
 * players of its own — the whole point is that nothing carries it — so every card here is
 * equally empty and the only thing that can still separate them is the crowds that do exist
 * next door: the busiest of its sub-combinations, and how much review attention its games
 * carry. That is exactly what `rankBy=potential` scores on a blanks-only board
 * (`emptyNeighbors` / `emptyNeighborDemand` in `public/engine/combos.js`); the other two rankings
 * in the API need a number this mode is defined by not having.
 */
const ORDER_NOTE = 'ordered by nearest-combination reviews';

/** The button's own label, kept in one place so the hint, the empty state and the note after a
 *  settings change can all point at the same words. */
const GO_LABEL = 'Search missed opportunities';

/**
 * One page and the whole board, declared once and repeated on every page: the same paging the
 * Finder does, with the same "Show N more" control, because a search that counted more than it
 * showed should say how many it is holding back rather than hide them.
 *
 * Three pages wide, the same as the Finder's board, and that width is what makes a second press
 * answer something different. A sweep board is a *sample* of the answer set, re-drawn per press:
 * at the default floor of 1,000 games the catalog holds only 209 length-2 gaps, so a board of 72
 * of them put the same 9 of 12 cards in front of a reader who pressed again (measured). Three pages
 * of that answer set share 3 of 12, and every page of one press is still a slice of one board.
 */
const PAGE = 12;
const BOARD = PAGE * 3;

let sweeping = false;
let sweepSeq = 0;
let swept = false;
// A press picks one seed; every page of that press's board asks for the same one, so paging walks
// one answer instead of drawing a fresh sample each time.
let sweepSeed = 0;
/** The board the current sweep built: `{ params, host, seq, found, pool, floor, ms, cached, shown, total }`. */
let board = null;

/* --------------------------------- the sweep ------------------------------- */

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  sweepSeq++;
  const seq = sweepSeq;
  const k = Number(els.k.value) || 2;
  const floor = Number(els.floor.value) || 1000;
  sweepSeed = Math.floor(Math.random() * 1e9) || 1;
  board = null;

  if (motionAllowed()) els.radar.classList.add('is-scanning');
  clear(els.results).append(spinner('searching for missed opportunities…'));
  // The sweep runs while the reader watches the radar, so the board it fills is scrolled into view
  // rather than appearing below the fold — only when it is off screen, and never while paging.
  scrollToInterest(els.results);
  els.stat.textContent = '';
  // Grey the controls, then wait for one painted frame: the sweep walks the beam on this thread, so
  // a phone spends several seconds there and would see a radar that never moved.
  const stop = setBusy(els.panel, { button: els.go, label: 'Searching…', disable: [els.k, els.floor] });
  await nextFrame();

  try {
    const params = {
      k,
      minCount: 0,
      maxCount: 0,
      includeEmpty: 1,
      emptyFloor: floor,
      rankBy: 'potential',
      thoroughness: 2,
      limit: PAGE,
      board: BOARD,
      gamesPerSpace: 2,
      seed: sweepSeed,
    };
    const out = await api.scan(params);
    if (seq !== sweepSeq) return;

    const host = clear(els.results);
    const spaces = out.spaces || [];
    board = {
      params,
      host,
      seq,
      found: Number(out.found) || 0,
      pool: Number(out.pool_size) || 0,
      // The payload says which floor the search actually used, so the line reports that rather
      // than what the panel thinks it asked for.
      floor: Number.isFinite(out.empty_floor) ? out.empty_floor : floor,
      ms: out.ms,
      cached: out.cached,
      total: Number.isFinite(out.board_total) ? out.board_total : spaces.length,
      shown: spaces.length,
    };
    if (!spaces.length) {
      host.append(emptyState('Nothing was missed at this floor. Lower the “Tags used by at least” limit, or use more tags per combination.'));
    }
    for (const space of spaces) {
      host.append(spaceCard(space));
    }
    paintBoardMore();
    swept = true;

    celebrate({ colors: ['#64f5c8', '#4fc3f7'], power: spaces.length ? 0.8 : 0.3, origin: { x: 0.5, y: 0.25 } });
    els.stat.textContent = sweepStat();
  } catch (err) {
    if (seq !== sweepSeq) return;
    clear(els.results).append(emptyState(`The search failed: ${err.message}`, true));
    els.stat.textContent = 'Search failed.';
  } finally {
    sweeping = false;
    // `stop()` puts the button's own words back — they can only ever be the label it had, since the
    // panel's settings are greyed for as long as a sweep runs. A newer sweep owns the grey from then
    // on, so an answer that arrives late leaves it alone.
    if (seq === sweepSeq) stop();
    setTimeout(() => els.radar.classList.remove('is-scanning'), 900);
  }
}

/** The line under the buttons: number facts about what the sweep did, then where the reader
 *  stands in it — the same shape the Finder's line uses, because both answer the same question
 *  of how much of a counted answer is on the screen. */
function sweepStat() {
  if (!board) return '';
  return `found ${fmtInt(board.found)} · on board ${fmtInt(board.total)} · shown ${fmtInt(board.shown)}`
    + ` · pool ${fmtInt(board.pool)} tags ≥ ${fmtInt(board.floor)} games · ${fmtInt(board.ms)} ms`
    + ` · ${ORDER_NOTE}`
    + (board.cached ? ' · cached' : '');
}

/** The control under the board: the next page of this same sweep, same seed, same order. */
function paintBoardMore() {
  if (!board) return;
  // The control belongs to one board. Capture it, so a page still in flight when a new sweep
  // starts cannot append its cards to the new one.
  const mine = board;
  paintMoreControl(mine.host, mine, {
    pageSize: PAGE,
    unit: 'combination',
    pending: 'Searching…',
    render: spaceCard,
    load: async (offset) => {
      if (mine !== board || mine.seq !== sweepSeq) return null;
      const out = await api.scan({ ...mine.params, offset });
      if (mine !== board || mine.seq !== sweepSeq) return null;
      return { items: out.spaces || [], total: out.board_total };
    },
  });
}

function spaceCard(space) {
  return comboCard(space, {
    // A tag on one of these cards is a tag like any other: it switches itself into the Finder's
    // tag box and waits for the button there, and clicking it again takes it back out.
    onTagClick: toggleTagInFinder,
    pickedIds: (tag) => selectedTags().some((t) => t.id === tag.id),
    // The nearest mix is the evidence a gap is real, and it is a question worth asking on its
    // own, so it goes to the Finder as a full combination — put in the box, not searched.
    onNeighbor: (tags) => openInFinder(tags, { run: false }),
    // The whole gap is the question here, so the card carries the same jump button every other
    // mode puts on its cards — the one that searches.
    onAction: [comboJumpAction(space), saveAction(space)],
  });
}

/* --------------------------------- wiring ---------------------------------- */

export function initUncharted(ctx) {
  els.go.addEventListener('click', () => {
    uiBlip();
    sweep();
  });
  // Changing a setting never starts a search by itself: the button is the only trigger.
  for (const node of [els.k, els.floor]) {
    node.addEventListener('change', () => {
      uiBlip();
      if (swept) els.stat.textContent = `Settings changed. Press “${GO_LABEL}”.`;
    });
  }

  return {
    ready() {
      clear(els.results).append(emptyState(`Nothing searched yet. Press “${GO_LABEL}”.`));
      markRarityLegend(els.legend, 'empty');
      els.stat.textContent = 'Nothing searched yet.';
    },
  };
}
