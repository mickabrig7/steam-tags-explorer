/* Mode 4 — Draft pick: a pool of tags is dealt from every tag in the catalog, a fixed number
   of them have to be disabled, and one tag combination is drawn from the tags that are left.
   The reel, the reveal and the run of draws are shared with the random draw. */

import { api } from './local-api.js';
import { clear, el, emptyState, fmtCompact, fmtInt, nextFrame, setBusy, TIER_FALLBACK } from './ui.js';
import {
  applyRarityAvailability, fillRarity, markRarityLegend, rarityBands, rarityDraw,
} from './rarity.js';
import { crateRumble, uiBlip } from './sound.js';
import { scrollToInterest } from './fx.js';
import {
  MIN_ANTICIPATION_MS,
  buildStrip,
  clearStrip,
  holdClosedCrate,
  hideClosedCrate,
  openCrateArt,
  showIdleCrate,
  sleep,
  spinStrip,
  travelFor,
} from './reel.js';
import {
  avoidList,
  comboNote,
  rememberDraw,
  renderDrawRun,
  renderReveal,
} from './reveal.js';

const els = {
  k: document.getElementById('draftK'),
  shown: document.getElementById('draftShown'),
  drop: document.getElementById('draftDrop'),
  rarity: document.getElementById('draftRarity'),
  deal: document.getElementById('draftDeal'),
  open: document.getElementById('draftOpen'),
  stat: document.getElementById('draftStat'),
  pool: document.getElementById('draftPool'),
  legend: document.getElementById('legendRarityDraft'),
  stage: document.getElementById('draftStage'),
  reel: document.getElementById('draftReel'),
  strip: document.getElementById('draftStrip'),
  art: document.getElementById('draftArt'),
  note: document.getElementById('draftNote'),
  reveal: document.getElementById('draftReveal'),
  streak: document.getElementById('draftStreak'),
  ladder: document.getElementById('draftLadder'),
  history: document.getElementById('draftHistory'),
  panel: document.getElementById('view-draft').querySelector('.console'),
};

let seed = 0;
let pool = null;
let off = new Set();
let history = [];
let pending = null;
let spinning = false;
let bandTiers = [];
let refreshTimer = 0;

const newSeed = () => Math.floor(Math.random() * 2_000_000_000);
const kSize = () => Number(els.k.value) || 3;
const shownSize = () => Number(els.shown.value) || 12;
const dropSize = () => Number(els.drop.value) || 1;
/** The dealt tags are buttons, so they can start work too: a census in flight must not take another. */
const poolChips = () => [...els.pool.querySelectorAll('.chip-pool')];

/**
 * A draft has no crate to pick — the reader picks the tags themselves, which is the whole
 * panel — so the pool is every catalogued tag on every deal. The `case` parameter stays on the
 * API (a crate pool still works from curl); leaving it out is how the page asks for the widest
 * pool there is, and the server's own default is the same answer.
 */
function draftParams() {
  const params = {
    k: kSize(),
    shown: shownSize(),
    seed,
  };
  if (off.size) params.disabled = [...off].join(',');
  return params;
}

/* --------------------------------- controls -------------------------------- */

/** At least `k` tags have to stay in the pool, so that is the most that can be disabled. */
function fillDropOptions() {
  const max = Math.max(1, shownSize() - kSize());
  const previous = Number(els.drop.value) || 0;
  // Until something is chosen, a draft leaves out about a quarter of the tags it shows.
  const wanted = previous || Math.max(1, Math.min(Math.round(shownSize() / 4), Math.max(1, max - 1)));
  clear(els.drop);
  for (let n = 1; n <= max; n++) {
    els.drop.append(el('option', { value: String(n), text: String(n) }));
  }
  els.drop.value = String(Math.min(Math.max(1, wanted), max));
}

/**
 * One Rarity control, the same list as in the random draw and the Finder. Every band is on
 * offer in every panel now; what differs here is only *which* options get greyed — the
 * census of the pool dealt on screen, not `band_gaps`.
 */
function fillRarityControl() {
  fillRarity(els.rarity, bandTiers);
}

/**
 * Disable the bands this pool has no combination in. The pool is small enough to
 * count in full, so the control only offers a guarantee this draft can keep.
 */
function applyRarityControl(bands) {
  const held = new Set((bands || []).map((band) => band.id));
  const missing = rarityBands(bandTiers)
    .filter((tier) => !held.has(tier.id))
    .map((tier) => tier.id);
  const dropped = applyRarityAvailability(
    els.rarity,
    bandTiers,
    missing,
    (tier) => `${tier.name}: none in this pool`,
  );
  if (dropped) {
    els.note.textContent = `No tag combination in this pool is ${tierNameOf(dropped)}. Choose another band.`;
  }
  markRarityLegend(els.legend, els.rarity.value);
}

function tierNameOf(tier) {
  return (tier && tier.name) || 'in that band';
}

/* ---------------------------------- the pool ------------------------------- */

function poolNote() {
  const wanted = dropSize();
  if (off.size < wanted) {
    const more = wanted - off.size;
    return `Disable ${more} more tag${more === 1 ? '' : 's'} before drawing.`;
  }
  if (off.size > wanted) return `Only ${wanted} tags may be disabled in this draft.`;
  return 'Press “Open crate”.';
}

function renderPool() {
  const host = clear(els.pool);
  if (!pool) {
    host.append(emptyState('No tags are shown. Press “Show new tags”.'));
    return;
  }
  for (const tag of pool.tags) {
    const isOff = off.has(tag.id);
    const chip = el('button', {
      type: 'button',
      className: isOff ? 'chip chip-pool is-off' : 'chip chip-pool',
      'aria-pressed': String(!isOff),
      title: isOff ? 'Disabled. Click to put this tag back in the pool.' : 'In the pool. Click to disable this tag.',
    }, [
      el('span', { text: tag.name }),
      el('span', { className: 'num', text: `${fmtCompact(tag.games)} games` }),
      el('span', { className: 'chip-state', text: isOff ? 'Disabled' : 'In pool' }),
    ]);
    chip.addEventListener('click', () => toggleTag(tag.id));
    host.append(chip);
  }
}

/** The line under the buttons: this pool and what can be drawn from it, as three numbers. */
function renderStat(info) {
  if (!info) {
    els.stat.textContent = '';
    return;
  }
  els.stat.textContent = `${fmtInt(info.in_pool)} tags in pool · ${fmtInt(info.combinations)} combinations`
    + ` · ${fmtInt(info.combinations_with_games)} with games`;
}

function syncOpenButton() {
  els.open.disabled = spinning || off.size !== dropSize() || !pool;
}

function toggleTag(id) {
  if (spinning) return;
  const wanted = dropSize();
  if (off.has(id)) {
    off.delete(id);
  } else if (off.size >= wanted) {
    els.note.textContent = `Only ${wanted} tag${wanted === 1 ? '' : 's'} may be disabled in this draft.`;
    return;
  } else {
    off.add(id);
  }
  els.note.textContent = poolNote();
  pending = null;
  syncOpenButton();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshPool, 140);
}

async function refreshPool() {
  clearTimeout(refreshTimer);
  const wantedSeed = seed;
  els.stat.textContent = 'Counting the combinations in this pool…';
  // A fresh pool is a census of every tag it deals, which is a synchronous second on a phone: the
  // controls that could start another one — the dealt tags included — go grey until this pool is
  // on the page. The button that opens the crate comes back through `syncOpenButton`, below.
  const stop = setBusy(els.panel, { disable: [els.open, els.deal, els.k, els.shown, els.drop, els.rarity, ...poolChips()] });
  await nextFrame();

  let view;
  try {
    view = await api.draftTags(draftParams());
  } catch (err) {
    if (wantedSeed !== seed) return;
    stop();
    pool = null;
    renderPool();
    renderStat(null);
    els.note.textContent = `This pool is not available: ${err.message}`;
    syncOpenButton();
    return;
  }
  // A newer deal of tags owns the grey from then on: a pool that arrives late must not lift it.
  if (wantedSeed !== seed) return;
  stop();
  pool = view;
  renderPool();
  renderStat(view.pool);
  applyRarityControl(view.pool.bands);
  els.note.textContent = poolNote();
  syncOpenButton();
  // The draw is prefetched as soon as the pool is in the state a draw needs.
  pending = off.size === dropSize() ? fetchDraw().catch(() => null) : null;
}

function newPool() {
  seed = newSeed();
  off.clear();
  pending = null;
  pool = null;
  fillDropOptions();
  els.reveal.hidden = true;
  clearStrip(els.strip);
  showIdleCrate(els);
  els.note.textContent = 'Showing new tags…';
  syncOpenButton();
  refreshPool();
}

/* --------------------------------- the draw -------------------------------- */

async function fetchDraw() {
  const params = { ...draftParams(), ...rarityDraw(els.rarity.value) };
  const avoid = avoidList(history);
  if (avoid) params.avoid = avoid;
  return api.draftDraw(params);
}

async function openDraftCrate() {
  if (spinning) return;
  const wanted = dropSize();
  if (off.size !== wanted) {
    els.note.textContent = poolNote();
    return;
  }

  const startedAt = Date.now();
  spinning = true;
  els.reveal.hidden = true;
  clearStrip(els.strip);
  // Same as the random draw: the reel has to be on screen for the deal to be watched.
  scrollToInterest(els.stage);
  els.note.textContent = 'Drawing from the tags left in this pool…';
  // Greyed, and painted before the engine is asked, exactly as in the other modes: this draw is
  // usually prefetched, but a press that finds nothing waiting pays for it there and then.
  const stop = setBusy(els.panel, {
    button: els.open,
    label: 'Opening…',
    disable: [els.deal, els.k, els.shown, els.drop, els.rarity, ...poolChips()],
  });
  await nextFrame();
  uiBlip();

  // The closed crate sits in the empty reel while the combination is picked.
  const holding = holdClosedCrate(els);
  if (holding) crateRumble(1.4);

  let draw;
  try {
    draw = pending ? await pending : await fetchDraw();
  } catch (err) {
    spinning = false;
    stop();
    hideClosedCrate(els);
    els.open.textContent = 'Open crate';
    els.note.textContent = `The draw failed: ${err.message}`;
    return;
  }
  pending = null;

  // Hold the closed crate in view long enough to be seen, even when the combination
  // was already fetched.
  if (holding) await sleep(Math.max(0, MIN_ANTICIPATION_MS - (Date.now() - startedAt)));

  const combo = draw.combo;
  const tier = combo.tier || TIER_FALLBACK;
  const info = draw.pool || {};

  const winners = new Set((combo.tags || []).map((t) => t.id));

  // The reel shows the tags that are left in this pool, so the cards that pass are
  // the tags this draft was drawn from.
  if (holding) {
    els.art.classList.remove('is-nudging');
    els.art.classList.add('is-spinning');
  } else {
    hideClosedCrate(els);
  }

  const plan = buildStrip(els, draw.pool.tags, winners, travelFor(tier));

  await spinStrip(els, plan, (openWindow) => openCrateArt(els, openWindow));

  els.note.textContent = comboNote(combo);
  renderStat(info);
  applyRarityControl(info.bands);

  history = rememberDraw(history, draw, tier);
  renderReveal(els, draw, tier);
  scrollToInterest(els.reveal);
  renderDrawRun(els, history);
  showIdleCrate(els);

  spinning = false;
  stop();
  els.open.textContent = 'Open another crate';
  pending = fetchDraw().catch(() => null);
  syncOpenButton();
}

/* --------------------------------- wiring ---------------------------------- */

export function initDraft(ctx) {
  els.open.addEventListener('click', openDraftCrate);
  els.deal.addEventListener('click', newPool);
  for (const node of [els.k, els.shown, els.drop]) {
    node.addEventListener('change', () => {
      if (node === els.drop) {
        // The number of tags to disable changed, so the old selection no longer applies.
        off.clear();
        els.note.textContent = poolNote();
        pending = null;
        syncOpenButton();
        refreshPool();
      } else {
        newPool();
      }
      uiBlip();
    });
  }
  els.rarity.addEventListener('change', () => {
    pending = off.size === dropSize() && pool ? fetchDraw().catch(() => null) : null;
    markRarityLegend(els.legend, els.rarity.value);
    syncOpenButton();
    uiBlip();
  });
  els.reveal.hidden = true;
  showIdleCrate(els);
  // The list of draws says what it is before there is anything in it, so the block under the
  // reel never arrives unlabeled.
  renderDrawRun(els, history);

  return {
    async ready() {
      try {
        const meta = ctx.meta ? await ctx.meta : await api.meta();
        bandTiers = meta.tiers || [];
        fillRarityControl();
        fillDropOptions();
        seed = newSeed();
        await refreshPool();
      } catch (err) {
        els.note.textContent = `The draft pick is not available: ${err.message}`;
      }
    },
  };
}
