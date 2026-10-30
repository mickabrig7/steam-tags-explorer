/* Shared DOM builders. Everything here is pure: pass data in, get nodes out. */

/** The band to show when a response has none — the busiest one, so nothing looks alarming. */
export const TIER_FALLBACK = { id: 'very_common', name: 'Very common', color: '#aab2c0', glow: 'rgba(170, 178, 192, 0.3)', blurb: '' };

export function el(tagName, opts = {}, children = []) {
  const node = document.createElement(tagName);
  const { className, text, html, dataset, ...attrs } = opts;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (html !== undefined) node.innerHTML = html;
  if (dataset) {
    for (const [key, value] of Object.entries(dataset)) node.dataset[key] = String(value);
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child) node.append(child);
  }
  return node;
}

export function fmtInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

export function fmtCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1000)}k`;
  if (abs >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return fmtInt(n);
}

/**
 * The same fact as the count line, as odds: `1 in 4,000 catalogued games`. A combination no
 * game carries has no odds to state — the count line already reads 0 — so it gets nothing.
 */
export function oddsLine(oneIn) {
  const n = Number(oneIn);
  if (!Number.isFinite(n) || n <= 1) return '';
  return `1 in ${fmtInt(n)} catalogued games`;
}

/** One count and one noun, in English: `1 game`, `4 games`. */
export function plural(count, word) {
  return Number(count) === 1 ? word : `${word}s`;
}

export function applyTier(node, tier) {
  const t = tier || TIER_FALLBACK;
  node.style.setProperty('--tier-color', t.color || TIER_FALLBACK.color);
  node.style.setProperty('--tier-glow', t.glow || t.color || TIER_FALLBACK.color);
  return t;
}

export function tierName(tier) {
  return (tier && tier.name) || TIER_FALLBACK.name;
}

export function tagChip(tag, { onClick, removable = false, onRemove, picked = false, syncPicked = null, title } = {}) {
  const chip = el('span', {
    className: onClick ? (picked ? 'chip chip-ghost is-picked' : 'chip chip-ghost') : 'chip',
    dataset: onClick ? { tag: String(tag.id) } : undefined,
    title: title ?? (onClick
      ? (picked
        ? `${tag.name} is in your tag box. Click to take it out.`
        : `Click to put ${tag.name} in your tag box.`)
      : undefined),
  }, [
    el('span', { text: tag.name }),
    el('span', { className: 'num', text: `${fmtCompact(tag.games)} games` }),
  ]);
  if (onClick) chip.addEventListener('click', () => {
    onClick(tag);
    // The gold mark follows the tag box, not a re-render: one mode marks its own board in
    // place, and the chip stays right even when the click only opened another panel.
    if (syncPicked) chip.classList.toggle('is-picked', Boolean(syncPicked(tag)));
  });
  if (removable) {
    const x = el('button', { type: 'button', 'aria-label': `Remove ${tag.name}`, text: '×' });
    x.addEventListener('click', (event) => {
      event.stopPropagation();
      if (onRemove) onRemove(tag);
    });
    chip.append(x);
  }
  return chip;
}

/**
 * The tags on a card. They are clickable everywhere: one click puts that single tag in
 * the Finder's tag box, which is never a search until the reader presses the button.
 * `title` may be a function, for panels where the jump to the Finder is worth naming.
 */
export function tagLine(tags, { onClick, pickedIds, title } = {}) {
  // `pickedIds` is either a Set frozen while rendering or a function of one tag. A mode
  // whose tag box is live state passes the function, so its chips stay honest after a
  // click that deliberately did not re-render the board.
  const isPicked = (tag) => (typeof pickedIds === 'function'
    ? pickedIds(tag)
    : Boolean(pickedIds && pickedIds.has(tag.id)));
  return el('div', { className: 'tagline' }, (tags || []).map((tag) => tagChip(tag, {
    onClick,
    picked: !!onClick && isPicked(tag),
    syncPicked: onClick ? isPicked : null,
    title: typeof title === 'function' ? title(tag) : title,
  })));
}

/** Steam ships a header image per app id; if the CDN 404s we keep the gradient plate. */
export function gameRow(game) {
  const row = el('a', { className: 'game', href: game.url, target: '_blank', rel: 'noopener noreferrer' });
  const img = el('img', {
    src: `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.app_id}/header.jpg`,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
  });
  img.addEventListener('error', () => img.remove(), { once: true });

  const body = el('div', { className: 'game-body' });
  body.append(el('div', { className: 'game-name', text: game.name || `Steam application ${game.app_id}` }));

  const meta = el('div', { className: 'game-meta' });
  if (Number.isFinite(game.reviews) && game.reviews > 0) {
    const good = Number.isFinite(game.review_percent) && game.review_percent >= 75;
    meta.append(
      el('span', {
        className: good ? 'good' : '',
        text: `${fmtCompact(game.reviews)} reviews${Number.isFinite(game.review_percent) ? ` · ${game.review_percent}% positive` : ''}`,
      }),
    );
  }
  if (game.review_label && game.review_label !== 'No Reviews') {
    meta.append(el('span', { text: game.review_label }));
  }
  if (game.year) meta.append(el('span', { text: `released ${game.year}` }));
  if (game.is_free) meta.append(el('span', { className: 'game-flag free', text: 'free' }));
  if (game.is_early_access) meta.append(el('span', { className: 'game-flag ea', text: 'early access' }));
  if (Number.isFinite(game.tags)) meta.append(el('span', { text: `${game.tags} tags` }));
  body.append(meta);

  row.append(img, body, el('span', { className: 'game-open', text: 'store page ↗' }));
  return row;
}

/**
 * The games a card lists, and the small control under them that shows the rest.
 * The control only exists when games are actually being held back: an offer to see
 * more of what is already on the card is not an offer.
 */
export function gameList(games, { total, note, onLoadMore, pageSize = 8 } = {}) {
  const list = el('div', { className: 'games' });
  const shown = (games || []).length;
  const all = Number.isFinite(total) ? total : shown;
  if (shown === 0) {
    list.append(el('p', { className: 'no-games', text: note || 'No game in the catalog has this combination.' }));
    return list;
  }
  for (const game of games) list.append(gameRow(game));
  if (all <= shown) return list;
  if (!onLoadMore) {
    const extra = all - shown;
    list.append(el('p', {
      className: 'stat-line',
      text: `+${fmtInt(extra)} more ${plural(extra, 'game')}`,
    }));
    return list;
  }
  paintMoreControl(list, { shown, total: all }, {
    pageSize,
    unit: 'game',
    load: (offset, take) => onLoadMore(offset, take).then((out) => ({
      items: (out && out.games) || [],
      total: out && Number.isFinite(out.total) ? out.total : undefined,
    })),
    render: gameRow,
  });
  return list;
}

/**
 * The one control for every list this page grows instead of replacing: the games under a card,
 * the combinations on a board. The rules are the same everywhere — it exists only while entries
 * are being held back, it says how many are left, it puts the new entries in front of itself,
 * and it is gone when the list runs out — so one implementation serves all of them, and a list
 * can never grow a button that behaves differently from the one above it.
 *
 * `state` is the caller's `{ shown, total }`. `load(offset, take)` resolves to
 * `{ items, total }`, or to `null` when the page belongs to an answer the caller has already
 * thrown away: the control then stays exactly where it is, for the list that replaced it.
 */
export function paintMoreControl(host, state, { pageSize, unit, load, render, onLoaded, pending = 'Reading…' }) {
  const hidden = state.total - state.shown;
  if (hidden <= 0) return;
  const take = Math.min(pageSize, hidden);
  const btn = el('button', {
    className: 'games-more',
    type: 'button',
    text: `Show ${take} more ${plural(take, unit)}`,
    title: `${fmtInt(hidden)} more ${plural(hidden, unit)} ${hidden === 1 ? 'is' : 'are'} waiting.`,
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = pending;
    // A page of a board is a fresh search, not a slice of a cached one, so this pill can sit on a
    // blocked thread for a second or two: the frame is what makes the wait visible.
    await nextFrame();
    try {
      const out = await load(state.shown, take);
      if (!out) return;
      const items = out.items || [];
      if (Number.isFinite(out.total)) state.total = out.total;
      state.shown += items.length;
      // Nothing came back: the list is as long as it is going to get.
      if (!items.length) state.shown = state.total;
      for (const item of items) host.insertBefore(render(item), btn);
      btn.remove();
      paintMoreControl(host, state, { pageSize, unit, load, render, onLoaded, pending });
      if (onLoaded) onLoaded(out);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = err.message || `Could not read more ${plural(take, unit)}`;
    }
  });
  host.append(btn);
}

/**
 * One value as a filled bar: the number on the left, the bar under it, filled from the left
 * in the card's own band colour so the length and the badge read as one fact. The track is a
 * bordered groove with quarter marks, so a short fill is still measured against something.
 */
export function meter(label, value, hint) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  const round = String(Math.round(pct));
  const wrap = el('div', { className: 'meter' }, [
    el('div', { className: 'meter-label' }, [
      el('span', { text: label }),
      el('b', { text: hint ?? round }),
    ]),
    el('div', {
      className: 'meter-track',
      role: 'meter',
      'aria-label': label,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': round,
    }, [el('span', { className: 'meter-fill', style: `width:${pct}%` })]),
  ]);
  return wrap;
}

/**
 * Two meters per card: "Rarity" is how few catalog games have this combination,
 * "Audience" is the review activity of the games that do.
 */
export function metersNode(space) {
  const row = el('div', { className: 'meters' });
  const gap = Number(space.count) === 0;
  row.append(meter('Rarity', space.openness ?? space.potential, `${Math.round(space.openness ?? space.potential ?? 0)}`));
  const heat = meter('Audience', space.heat, `${Math.round(space.heat ?? 0)}`);
  if (gap) heat.title = 'No game carries this combination, so this meter describes its nearest combinations instead.';
  row.append(heat);
  if (space.stat_trak) {
    row.append(el('span', {
      className: 'stattrak',
      title: 'At least one game with this combination has 50,000 or more reviews and 90% or more positive.',
      text: 'Well-reviewed title',
    }));
  }
  return row;
}

/**
 * One result card for a tag mix. `space` is either a scan space or a combo summary —
 * the shapes overlap enough that one renderer handles both.
 */
export function comboCard(space, {
  hero = false,
  onTagClick,
  pickedIds,
  onNeighbor,
  onAction,
  onLoadMore,
} = {}) {
  const card = el('article', { className: hero ? 'card card-hero' : 'card' });
  const tier = applyTier(card, space.tier);

  // The badge names the band, the rarity block beside the controls spells out its range, and the
  // odds under the tags restate the same fact as a ratio — so the count line is a number and its
  // unit, not a sentence. One number, one meaning: the catalogued games carrying this combination,
  // which is also the list the games under the card page through.
  const catalog = Number(space.count) || 0;

  const headParts = [el('span', { className: 'tier-badge', text: tierName(tier) })];
  headParts.push(el('div', { className: 'card-count' }, [
    el('b', { text: fmtInt(catalog) }),
    el('span', { text: `${plural(catalog, 'game')} in the catalog` }),
  ]));
  const head = el('div', { className: 'card-head' }, headParts);
  card.append(head);
  const odds = oddsLine(space.oneIn);
  if (odds) card.append(el('p', { className: 'tier-blurb', text: odds }));
  card.append(tagLine(space.tags, { onClick: onTagClick, pickedIds }));
  card.append(metersNode(space));

  if (space.neighbors && space.neighbors.length) {
    // Nothing here says the entries are clickable. Everything on a card is, and a hint that
    // only one kind of thing obeys it says more about the design than about the answer.
    const note = el('div', { className: 'empty-note' }, [
      el('span', { text: 'Nearest combinations in the catalog:' }),
    ]);
    const row = el('div', { className: 'neighbors' });
    for (const n of space.neighbors) {
      const names = (n.tags || []).map((t) => t.name).join(' + ');
      const cell = onNeighbor
        ? el('button', {
            className: 'neighbor',
            type: 'button',
            title: `Put ${names} in the Finder — nothing is searched until you press the button.`,
          })
        : el('span', { className: 'neighbor' });
      cell.append(el('b', { text: names }));
      cell.append(el('span', { text: ` · ${fmtInt(n.count)} ${plural(n.count, 'game')}` }));
      if (onNeighbor) cell.addEventListener('click', () => onNeighbor(n.tags || [], n));
      row.append(cell);
    }
    note.append(row);
    card.append(note);
  }

  if (onAction && onAction.length) {
    const actions = el('div', { className: 'card-actions' });
    for (const action of onAction) {
      // `label` may be left out when the button's owner sets its text in `onCreate`,
      // which is how the save button keeps its label in step with the saved panel.
      const btn = el('button', { className: 'mini-btn', type: 'button', text: action.label });
      btn.addEventListener('click', () => action.run(space, btn, card));
      if (action.onCreate) action.onCreate(btn);
      actions.append(btn);
    }
    card.append(actions);
  }

  if (space.games) {
    card.append(gameList(space.games, {
      total: catalog,
      onLoadMore,
    }));
  }
  return card;
}

export function emptyState(text, isError = false) {
  return el('p', { className: isError ? 'empty-state error-state' : 'empty-state', text });
}

export function spinner(text) {
  return el('p', { className: 'empty-state', text });
}

/**
 * Wait for one painted frame.
 *
 * `local-api.js` asks the engine in-process, so a search is one synchronous task on this thread:
 * a second or three in which nothing repaints and no CSS animation advances. Whatever a panel
 * wants the reader to *see* while that runs has to be painted first, and a paint only happens at
 * a frame boundary the thread is free for. The first `requestAnimationFrame` asks for the next
 * frame; the second is a callback that can only run after that frame has been drawn.
 */
export function nextFrame() {
  return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
}

/**
 * Grey a panel while it works — the one owner, shared by all four modes.
 *
 * The panel takes `.is-busy` (dimmed controls, wait cursor, `aria-busy`), every control that could
 * start a second job is disabled, and the button says what it is doing. The button's room is
 * reserved before its words change: swapping **Search combinations** for **Searching…** must not
 * slide the row of controls, the same rule that makes the stat line reserve its height.
 *
 * `stop()` puts each control's *previous* disabled state back, so a button that was unavailable
 * for its own reason — Draft's **Open crate** until enough tags are disabled — comes back
 * unavailable rather than pressable. It restores the button's words only if nobody named them in
 * the meantime, which is how a panel that renames its button after a press (**Open another
 * crate**) keeps that wording.
 *
 * @returns {() => void} put everything back; safe to call twice.
 */
export function setBusy(panel, { button, label, disable = [] } = {}) {
  const nodes = [button, ...disable].filter(Boolean);
  const was = nodes.map((node) => node.disabled);
  for (const node of nodes) node.disabled = true;

  let idle = null;
  if (button && label) {
    button.style.minWidth = `${button.getBoundingClientRect().width}px`;
    idle = button.textContent;
    button.textContent = label;
  }

  panel.classList.add('is-busy');
  panel.setAttribute('aria-busy', 'true');

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    panel.classList.remove('is-busy');
    panel.removeAttribute('aria-busy');
    nodes.forEach((node, i) => { node.disabled = was[i]; });
    if (button && idle !== null && button.textContent === label) button.textContent = idle;
  };
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

const CASE_GLYPH = { wildcard: '🎲', indie: '🌻', cozy: '☕', nightmare: '🕯️', loop: '⚙️', crowd: '🏟️', toolkit: '🔧' };

/** One option per crate, with the glyph both draw pickers show. */
export function fillCases(select, cases) {
  clear(select);
  for (const item of cases || []) {
    select.append(el('option', { value: item.id, text: `${CASE_GLYPH[item.art] || '🎲'} ${item.name}` }));
  }
}

/** A band's count range as the block says it: `0`, `5–24`, `10,000+`. */
export function bandRange(tier) {
  const min = Number(tier.min) || 0;
  const max = tier.max == null ? null : Number(tier.max);
  if (max === 0) return '0';
  if (max == null) return `${fmtInt(min)}+`;
  return min === max ? fmtInt(min) : `${fmtInt(min)}–${fmtInt(max)}`;
}

/**
 * The rarity block: every band in the catalog, its colour, and how many catalogued games put a
 * combination in it — rarest at the top, so it reads in the same order as the Rarity control it
 * sits beside. Rows, not table cells: one row is a dot, a band name that gets the room it needs,
 * and its exact range in a right-aligned column of tabular figures, under one caption saying what
 * the numbers count. Every mode shows the same block, so no panel has to explain the bands in
 * words and a band badge on a card always has its key a few lines above it. Each row carries
 * `data-band` plus the band's own `data-min`/`data-max`, so a mode can light up the rows its
 * Rarity control covers without holding a copy of the thresholds
 * (`rarity.js markRarityLegend`).
 */
export function rarityLegend(tiers) {
  const rows = el('div', { className: 'legend-rows' });
  for (const tier of tiers || []) {
    const range = bandRange(tier);
    const max = tier.max == null ? null : Number(tier.max);
    rows.append(el('div', {
      className: 'legend-row',
      'data-band': tier.id,
      'data-min': String(Number(tier.min) || 0),
      'data-max': max === null ? '' : String(max),
    }, [
      el('span', { className: 'legend-dot', style: `background:${tier.color}`, 'aria-hidden': 'true' }),
      el('span', { className: 'legend-key', text: tier.name }),
      el('span', { className: 'legend-value', title: `${tier.name}: ${range} games`, text: range }),
    ]));
  }
  return el('div', { className: 'legend-block legend-block-rarity' }, [
    el('p', { className: 'legend-title', text: 'Rarity bands' }),
    el('p', { className: 'legend-note', text: 'games carrying the combination' }),
    rows,
  ]);
}

/**
 * The crate block: every crate the picker offers, its glyph, and the one thing that sets it
 * apart. It belongs to a single field, so it sits above that field and the reader compares the
 * options before choosing one; it folds, because seven rows of reference is a lot of screen to
 * hold once the choice is made. Rows, exactly like the rarity block: one row per crate.
 */
export function caseLegend(cases) {
  const rows = el('div', { className: 'legend-rows legend-rows-cases' });
  for (const item of cases || []) {
    rows.append(el('div', { className: 'legend-row legend-row-case' }, [
      el('span', { className: 'legend-glyph', 'aria-hidden': 'true', text: CASE_GLYPH[item.art] || '🎲' }),
      el('span', { className: 'legend-key', text: item.name }),
      el('span', { className: 'legend-blurb', text: item.blurb || '' }),
    ]));
  }
  return el('details', { className: 'legend-block legend-block-cases', open: true }, [
    el('summary', { className: 'legend-title', text: 'Crates, and what each one draws from' }),
    rows,
  ]);
}
