/* The reel both draw modes share: the card strip, the spin, and the crate graphic.
   Nothing here knows which mode it is running for. */

import { el, fmtCompact } from './ui.js';
import { motionAllowed } from './fx.js';
import { cratePop, reelTick } from './sound.js';

export const CARD_STEP = 178; /* 168px card + 10px gap, matching styles.css (fallback only) */
export const PAD_SLOTS = 4; /* blank travel slots appended after the last card */
export const TAIL_SLOTS = 8; /* real cards after the winning block, so the strip keeps running past it */
/* How far the strip runs before it stops, by band id. Rarer draws run further.
   Keep the rows in step with public/engine/tiers.js. */
export const SPIN_REACH = { empty: 1, almost_empty: 0.92, very_rare: 0.82, rare: 0.7, uncommon: 0.55, fairly_common: 0.4, common: 0.25, very_common: 0.1 };
export const SHORTEST_TRAVEL = 2800;
export const LONGEST_TRAVEL = 7400;
export const MIN_OPEN_WINDOW_MS = 900; /* shortest lid/box/glow window: it always spans the tail of the spin */
export const MIN_ANTICIPATION_MS = 550; /* the closed crate stays visible even when the draw was prefetched */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function travelFor(tier) {
  const reach = SPIN_REACH[(tier && tier.id) || 'very_common'] ?? 0.4;
  const wanted = SHORTEST_TRAVEL + (LONGEST_TRAVEL - SHORTEST_TRAVEL) * reach;
  return Math.round(wanted * (0.92 + Math.random() * 0.16));
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = list[i];
    list[i] = list[j];
    list[j] = swap;
  }
  return list;
}

/** Distance between two neighbouring slots, read from the laid out cards. */
function measurePitch(cards) {
  const filled = cards.filter((card) => !card.classList.contains('reel-pad'));
  if (filled.length < 2) return CARD_STEP;
  const pitch = filled[1].offsetLeft - filled[0].offsetLeft;
  return pitch > 0 ? pitch : CARD_STEP;
}

/* --------------------------------- the strip ------------------------------- */

/** Lay out one draw: filler cards, the winning block, more cards, then blank slots. */
export function buildStrip(stage, tags, winners, travel) {
  const { reel, strip } = stage;
  clearStrip(strip);

  const viewport = reel.clientWidth || 800;
  const pool = [];
  for (const tag of tags) pool.push({ tag, winning: winners.has(tag.id) });

  const winning = pool.filter((item) => item.winning);
  const others = pool.filter((item) => !item.winning);
  if (!others.length) others.push(...winning);
  shuffle(others);

  // The winning block sits a long way down the strip, so the reel runs for
  // thousands of pixels before it stops. More real cards follow it, and blank
  // slots after those keep the end of the strip off the screen.
  const middle = Math.floor((winning.length - 1) / 2);
  const blockStart = Math.max(2, Math.round((travel - viewport / 2 + CARD_STEP / 2) / CARD_STEP) - middle);

  const ordered = [];
  for (let i = 0; i < blockStart; i++) ordered.push(others[i % others.length]);
  ordered.push(...winning);
  for (let i = 0; i < TAIL_SLOTS; i++) ordered.push(others[(blockStart + middle + 1 + i) % others.length]);
  for (let i = 0; i < PAD_SLOTS; i++) ordered.push(null);

  const cards = ordered.map((item) => {
    if (!item) return el('div', { className: 'reel-pad', 'aria-hidden': 'true' });
    const card = el('div', { className: 'reel-card' }, [
      el('span', { text: item.tag.name }),
      el('span', { className: 'reel-count', text: `${fmtCompact(item.tag.games)} games` }),
    ]);
    if (item.winning) card.dataset.winner = '1';
    return card;
  });

  for (const card of cards) strip.append(card);
  // The names are unreadable until the crate opens, which is the moment the draw is
  // supposed to land. The count under each name stays readable: it gives nothing away
  // about which tags won, and it is what makes the strip look like a reel.
  if (motionAllowed()) strip.classList.add('is-blurred');
  return { cards, pitch: measurePitch(cards), winnerSlot: blockStart + middle };
}

export function clearStrip(strip) {
  strip.style.transform = 'translate3d(0, 0, 0)';
  strip.classList.remove('is-blurred');
  while (strip.firstChild) strip.firstChild.remove();
}

/* ---------------------------------- the spin ------------------------------- */

/** Run the strip down the reel, drift past the winning card and settle back onto it. */
export function spinStrip(stage, plan, onOpening) {
  const { reel, strip, art } = stage;
  const { cards, pitch, winnerSlot } = plan;
  const viewport = reel.clientWidth || 800;
  const target = Math.max(0, winnerSlot * pitch + pitch / 2 - viewport / 2);
  const maxTravel = Math.max(0, strip.scrollWidth - viewport);
  const distance = Math.min(target, maxTravel);
  const overshoot = Math.max(0, Math.min(18, maxTravel - distance));
  const duration = motionAllowed() ? Math.round(1500 + distance * 0.42) : 1;
  const settleLength = 340;
  let openTimer = 0;

  // The crate is gone the moment the reel lands, so nothing of it is left over the
  // highlighted tags or the reveal card.
  const land = () => {
    clearTimeout(openTimer);
    art.hidden = true;
    art.classList.remove('is-spinning', 'is-open', 'is-nudging');
    strip.classList.remove('is-blurred');
    for (const card of cards) if (card.dataset.winner) card.classList.add('is-win');
  };

  return new Promise((resolve) => {
    if (!motionAllowed()) {
      strip.style.transform = `translate3d(-${distance}px, 0, 0)`;
      land();
      resolve(winnerSlot);
      return;
    }

    const start = performance.now();
    let lastSlot = -1;

    const tick = (position, speed) => {
      const slot = Math.round((position + viewport / 2) / pitch);
      if (slot === lastSlot) return;
      if (lastSlot !== -1) reelTick(speed);
      lastSlot = slot;
    };

    // Past the winning card and back again: a short drift forward, then a spring back.
    const settleStart = performance.now();
    const settle = (now) => {
      const u = Math.min(1, (now - settleStart) / settleLength);
      const offset = Math.sin(u * Math.PI) * overshoot;
      tick(distance + offset, 0.4);
      strip.style.transform = `translate3d(-${distance + offset}px, 0, 0)`;
      if (u < 1) {
        requestAnimationFrame(settle);
        return;
      }
      strip.style.transform = `translate3d(-${distance}px, 0, 0)`;
      land();
      resolve(winnerSlot);
    };

    const frame = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const position = distance * (1 - Math.pow(1 - t, 4));
      tick(position, t < 0.7 ? 1 : 0.6);
      strip.style.transform = `translate3d(-${position}px, 0, 0)`;
      if (t < 1) {
        requestAnimationFrame(frame);
        return;
      }
      requestAnimationFrame(settle);
    };

    // The crate opens over the still-scrolling cards: that window starts about 40%
    // before the reel lands, and its lid, box and glow animations end with the landing.
    const openWindow = Math.max(MIN_OPEN_WINDOW_MS, Math.round((duration + settleLength) * 0.4));
    openTimer = setTimeout(
      () => { if (onOpening) onOpening(openWindow); },
      Math.max(0, duration + settleLength - openWindow),
    );

    requestAnimationFrame(frame);
  });
}

/* ------------------------------- the crate art ------------------------------ */

/** The closed crate shows in an empty reel and stays out once cards are on screen. */
export function showIdleCrate(stage) {
  const { art, strip } = stage;
  art.classList.remove('is-open', 'is-nudging', 'is-spinning');
  art.hidden = strip.children.length > 0;
}

/** The closed crate sits in the reel while the combination is picked. */
export function holdClosedCrate(stage) {
  const { art } = stage;
  if (!motionAllowed()) return false;
  art.hidden = false;
  art.classList.remove('is-open', 'is-spinning');
  art.classList.add('is-nudging');
  return true;
}

export function hideClosedCrate(stage) {
  const { art } = stage;
  art.classList.remove('is-nudging', 'is-open', 'is-spinning');
  art.hidden = true;
}

/** Start the lid, box and glow so they end at the same moment the strip lands. */
export function openCrateArt(stage, openWindow) {
  const { art, strip } = stage;
  art.style.setProperty('--open-ms', `${openWindow}ms`);
  art.style.setProperty('--box-fade-ms', `${Math.round(openWindow * 0.45)}ms`);
  art.style.setProperty('--box-fade-delay', `${Math.round(openWindow * 0.55)}ms`);
  art.classList.add('is-open');
  // The names behind the lid become readable on the same schedule the lid lifts, so the
  // opening and the reveal of the tags are one movement rather than two.
  strip.style.setProperty('--unblur-ms', `${Math.round(openWindow * 0.75)}ms`);
  strip.classList.remove('is-blurred');
  cratePop();
}
