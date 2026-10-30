/* Mode 2 — Random draw: one random tag combination, revealed with a reel spin.
   Spin length, sound and confetti follow the rarity of the draw. The reel itself
   lives in reel.js and is shared with the draft pick. */

import { api } from './local-api.js';
import { fillCases, fmtInt, nextFrame, setBusy, TIER_FALLBACK } from './ui.js';
import { applyRarityAvailability, fillRarity, markRarityLegend, rarityDraw } from './rarity.js';
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
  case: document.getElementById('crateCase'),
  k: document.getElementById('crateK'),
  rarity: document.getElementById('crateRarity'),
  legend: document.getElementById('legendRarityCrate'),
  open: document.getElementById('crateOpen'),
  stage: document.getElementById('crateStage'),
  reel: document.getElementById('crateReel'),
  strip: document.getElementById('crateStrip'),
  art: document.getElementById('crateArt'),
  note: document.getElementById('crateNote'),
  reveal: document.getElementById('crateReveal'),
  streak: document.getElementById('crateStreak'),
  ladder: document.getElementById('crateLadder'),
  history: document.getElementById('crateHistory'),
  panel: document.getElementById('view-crate').querySelector('.console'),
};

let history = [];
let pending = null;
let spinning = false;
let rarityTiers = [];
let bandGaps = {};

/* --------------------------------- controls -------------------------------- */

/**
 * One control for how rare the draw should be: the two ends of the range weight the roll
 * and leave the reel free, a named band commits the draw to landing there. `empty` is on
 * offer like anywhere else — a crate rolls over the whole tag pool, where gaps far outnumber
 * the pairs in it, so `Guarantee empty` is a band the reel can genuinely land on.
 */
function fillRarityControl(tiers, gaps) {
  rarityTiers = tiers || [];
  bandGaps = gaps || {};
  fillRarity(els.rarity, rarityTiers);
  applyRarityControl();
}

/**
 * Disable the bands this mix size cannot reach. No five tags in the catalog are
 * used by ten thousand games, so the control never offers a guarantee the draw
 * could not keep.
 */
function applyRarityControl() {
  const k = Number(els.k.value) || 3;
  const dropped = applyRarityAvailability(
    els.rarity,
    rarityTiers,
    bandGaps[k] || [],
    (tier) => `${tier.name}: not possible with ${k} tags`,
  );
  if (dropped) {
    els.note.textContent = `No combination of ${k} tags reaches ${fmtInt(dropped.min)} ${dropped.min === 1 ? 'game' : 'games'} in the catalog. Choose a lower band or fewer tags.`;
  }
  markRarityLegend(els.legend, els.rarity.value);
}

async function fetchDraw() {
  const params = {
    k: Number(els.k.value) || 3,
    case: els.case.value || 'wildcard',
    ...rarityDraw(els.rarity.value),
  };
  const avoid = avoidList(history);
  if (avoid) params.avoid = avoid;
  return api.draw(params);
}

/* --------------------------------- the draw -------------------------------- */

export async function openCrate() {
  if (spinning) return;
  const startedAt = Date.now();
  spinning = true;
  els.reveal.hidden = true;
  clearStrip(els.strip);
  // The reel is where a draw happens, so the crate comes to the reader: press **Open crate** near
  // the bottom of the panel and the stage is on screen before the first card starts moving.
  scrollToInterest(els.stage);
  els.note.textContent = 'Drawing a combination…';
  // Grey the panel and wait for that to be drawn before asking the engine: a draw at length 5 in a
  // busy band holds this thread for up to a second and a half, and a phone would otherwise show a
  // crate that looks untouched while it is actually working.
  const stop = setBusy(els.panel, { button: els.open, label: 'Opening…', disable: [els.case, els.k, els.rarity] });
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

  // Start the next draw while this one is still animating, so the next press feels instant.
  pending = fetchDraw().catch(() => null);

  const winners = new Set((combo.tags || []).map((t) => t.id));

  // The closed crate stays in front of the reel while the cards start scrolling, then
  // opens over them: its lid, box and glow are timed to finish exactly when the reel
  // lands on the winning tags.
  if (holding) {
    els.art.classList.remove('is-nudging');
    els.art.classList.add('is-spinning');
  } else {
    hideClosedCrate(els);
  }

  const plan = buildStrip(
    els,
    draw.reel ? draw.reel.strip.map((slot) => slot.tag) : combo.tags,
    winners,
    travelFor(tier),
  );

  await spinStrip(els, plan, (openWindow) => openCrateArt(els, openWindow));

  els.note.textContent = comboNote(combo);

  history = rememberDraw(history, draw, tier);
  renderReveal(els, draw, tier);
  // The answer, not the reel, is what the reader came for: bring the revealed combination in when
  // the spin pushed it below the fold.
  scrollToInterest(els.reveal);
  renderDrawRun(els, history);
  showIdleCrate(els);

  spinning = false;
  stop();
  els.open.textContent = 'Open another crate';
}

/* --------------------------------- wiring ---------------------------------- */

export function initCrate(ctx) {
  els.open.addEventListener('click', openCrate);
  for (const node of [els.case, els.k, els.rarity]) {
    node.addEventListener('change', () => {
      pending = null;
      // A new length changes which bands this catalog can guarantee at all, so the greying
      // pass runs again — and it re-marks the rarity block as a side effect. The mark also
      // belongs to the Rarity control itself, so changing that control re-marks it directly:
      // the option means the same range here as in the Finder, *Prioritize rare* covering
      // 0 to 99 games with the gap band included.
      if (node === els.k) applyRarityControl();
      else if (node === els.rarity) markRarityLegend(els.legend, els.rarity.value);
      uiBlip();
    });
  }
  els.reveal.hidden = true;
  showIdleCrate(els);
  // The list of draws says what it is before there is anything in it, so the block under the
  // reel never arrives unlabeled.
  renderDrawRun(els, history);

  return {
    async ready() {
      try {
        const [cases, meta] = await Promise.all([api.cases(), ctx.meta ? Promise.resolve(ctx.meta) : api.meta()]);
        fillCases(els.case, cases.cases || []);
        fillRarityControl(meta.tiers || [], meta.band_gaps || {});
        els.note.textContent = 'Pick a crate and open it.';
        pending = fetchDraw().catch(() => null);
      } catch (err) {
        els.note.textContent = `The random draw is not available: ${err.message}`;
      }
    },
  };
}
