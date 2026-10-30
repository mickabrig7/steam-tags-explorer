/* What a draw shows after the reel stops: the combination, its neighbours, and the run of draws
   so far. Shared word for word by the random draw and the draft pick — including the list of
   draws under the reel, which is a list of combinations like any other, so its rows lead back to
   the Finder exactly as a ladder rung or a saved row does. */

import { api } from './local-api.js';
import { openInFinder, selectedTags, toggleTagInFinder } from './main.js';
import { applyTier, clear, comboCard, el, fmtInt, plural, tagChip, tierName } from './ui.js';
import { celebrate, flash } from './fx.js';
import { revealChord } from './sound.js';
import { comboJumpAction, saveAction } from './vault.js';

export function tagNames(tags) {
  return (tags || []).map((t) => t.name).join(' + ');
}

/**
 * The drawn mix as a number fact, the same shape as every other stat line on the page:
 * `Co-op + Roguelike + Deckbuilder · 47,291 games`. A gap says the same thing with a 0 in it,
 * because that is the answer, not a missing one.
 */
export function comboNote(combo) {
  const count = Number(combo.count) || 0;
  return `${tagNames(combo.tags)} · ${fmtInt(count)} ${plural(count, 'game')}`;
}

/** The last few draws, so the next one is not the same combination again. */
export function avoidList(history) {
  return history.slice(0, 12).map((entry) => entry.key).join(';');
}

export function rememberDraw(history, draw, tier) {
  // The key goes back to the server as `avoid`, so it carries the public tag ids
  // the API answers with, not the numbers the server uses inside a request. The tags
  // themselves are kept as well: a row of the history is a combination, and clicking one
  // hands those same tags to the Finder.
  const tags = draw.combo.tags || [];
  const key = tags.map((t) => t.id).join(',');
  history.unshift({ key, names: tagNames(tags), count: draw.combo.count, tier, tags });
  // The list on screen stays short; the draw keeps a longer memory of what it has
  // already handed out.
  return history.slice(0, 12);
}

/**
 * The run of draws under the reel, under a heading that says what it is — the heading is in the
 * markup, so it is there before the first draw and the list never arrives unlabeled. A draw
 * already made is a combination like any other, so its row is a button: one click takes that mix
 * to the Finder and searches it, just as a ladder rung or a saved row does.
 */
export function renderDrawRun(els, history) {
  const shown = history.slice(0, 6);
  const host = clear(els.history);
  if (!shown.length) {
    host.append(el('p', { className: 'side-empty', text: 'No draws yet.' }));
    return;
  }
  for (const entry of shown) {
    const count = Number(entry.count) || 0;
    const item = el('button', {
      className: 'history-item',
      type: 'button',
      title: `${entry.names} — search this combination in the Finder`,
    }, [
      el('span', { className: 'dot', style: `background:${entry.tier.color || '#aab2c0'}` }),
      el('span', { text: entry.names }),
      el('span', { className: 'saved-when', text: `${fmtInt(count)} ${plural(count, 'game')}` }),
    ]);
    item.addEventListener('click', () => openInFinder(entry.tags, { run: true }));
    host.append(item);
  }

  const emptiest = shown.reduce((best, entry) => (entry.count < best.count ? entry : best), shown[0]);
  const emptyCount = Number(emptiest.count) || 0;
  const veryRare = shown.filter((entry) => ['empty', 'almost_empty', 'very_rare'].includes(entry.tier.id)).length;
  clear(els.streak).append(
    el('span', { text: `${fmtInt(shown.length)} draws · rarest ` }),
    el('b', { text: emptiest.names }),
    el('span', { text: ` · ${fmtInt(emptyCount)} ${plural(emptyCount, 'game')}` }),
    ...(veryRare
      ? [el('span', { text: ' · ' }), el('b', { text: fmtInt(veryRare) }), el('span', { text: ` very rare ${plural(veryRare, 'draw')}` })]
      : []),
  );
}

/* ---------------------------------- the card ------------------------------- */

/** The drawn combination: its band, its games, the neighbours it sits beside. */
export function renderReveal(els, draw, tier) {
  const host = clear(els.reveal);
  els.reveal.hidden = false;
  applyTier(host, tier);

  host.append(el('div', { className: 'reveal-tier', text: tierName(tier) }));

  // Nothing is said about where the draw was aimed. The Rarity control greys out what this
  // catalog or this pool cannot offer, every option means one range of counts here as in the
  // Finder, and the band word above already says where this one landed - so a draw that came
  // out Empty needs no apology, and a draw inside a named band needs no restating.
  host.append(comboCard(draw.combo, {
    // A tag on the drawn card behaves like a tag on any other card: it switches itself into the
    // Finder's tag box and stops there, and the mark on it follows the box from then on.
    onTagClick: toggleTagInFinder,
    pickedIds: (tag) => selectedTags().some((t) => t.id === tag.id),
    // A neighbour of the drawn mix is a combination in its own right: clicking it puts that
    // set of tags in the Finder's box, where the reader decides what to do with them.
    onNeighbor: (tags) => openInFinder(tags, { run: false }),
    // The same two buttons every mode puts on a result card — one that asks about the whole
    // combination, one that saves it — and the games under the card page themselves, exactly as
    // they do on a Finder card.
    onAction: [comboJumpAction(draw.combo), saveAction(draw.combo)],
    onLoadMore: (offset, limit) => api.games(
      (draw.combo.tags || []).map((t) => t.id),
      { limit, offset },
    ),
  }));

  revealChord(tier.id);
  flash(tier.glow || tier.color);
  celebrate({
    colors: [tier.color, tier.color, '#f7ce46', '#64f5c8'],
    power: ['empty', 'almost_empty', 'very_rare', 'rare'].includes(tier.id) ? 1.6 : 1,
  });

  renderLadder(els.ladder, draw.ladder);
}

/**
 * The other combinations this draw touched: the mix with one tag dropped, once for each tag. The
 * heading sits in the markup beside the one over the history, so the two lists under the reel are
 * introduced the same way — and the block folds away when a draw has nothing to put in it, rather
 * than leaving a heading over an empty box.
 */
export function renderLadder(host, ladder) {
  const target = clear(host);
  const block = host.closest('.side-block');
  const has = Boolean(ladder && ladder.length);
  if (block) block.hidden = !has;
  if (!has) return;
  for (const rung of ladder) {
    const names = (rung.tags || []).map((t) => t.name).join(' + ');
    const chip = tagChip({ name: names, games: rung.count }, {
      onClick: () => openInFinder(rung.tags, { run: true }),
      title: `${names} — search this combination in the Finder`,
    });
    chip.style.setProperty('--tier-color', (rung.tier && rung.tier.color) || '#aab2c0');
    target.append(chip);
  }
}
