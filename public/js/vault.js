/* The saved panel: one collapsible drawer pinned to the right edge that holds every
   saved combination, whichever mode saved it. The panel also owns what "saved" means:
   it keeps the set of saved combinations, and re-paints the save button of every card
   on screen whenever that set changes. All four modes get their save button from
   saveAction() below, so a button can never disagree with the panel — and all four get
   their "ask about this whole combination" button from comboJumpAction() below, for the
   same reason. */

import { api } from './local-api.js';
import { openInFinder, selectedTags, sinceLabel, toggleTagInFinder } from './main.js';
import { applyTier, clear, el, fmtInt, gameRow, paintMoreControl, plural, tagChip } from './ui.js';
import { motionAllowed } from './fx.js';
import { uiBlip } from './sound.js';

const els = {
  vault: document.getElementById('vault'),
  rail: document.getElementById('vaultToggle'),
  flag: document.getElementById('vaultFlag'),
  panel: document.getElementById('vaultPanel'),
  count: document.getElementById('vaultCount'),
  sub: document.getElementById('vaultSub'),
  list: document.getElementById('vaultList'),
  collapse: document.getElementById('vaultCollapse'),
  topbar: document.querySelector('.topbar'),
};

const OPEN_KEY = 'steamtage:vault-open';
const GAMES_SHOWN = 3;

/** Saved rows, newest first, straight from the API. */
let spaces = [];
/** combination key -> saved row id, so a card can tell whether it is already saved. */
const keys = new Map();
/** combination key -> { count, tier, games, total }, read once per combination. */
const details = new Map();
let open = false;
let loader = null;

/* --------------------------------- identity -------------------------------- */

/** One saved combination, however the tags arrive, is one key. */
export function comboKey(tagsOrIds) {
  const ids = (tagsOrIds || [])
    .map((tag) => (typeof tag === 'number' ? tag : tag && tag.id))
    .filter((id) => Number.isFinite(id))
    .sort((a, b) => a - b);
  return ids.join(',');
}

/* ---------------------------- buttons that follow the saved set ---------------------------- */

/** Save buttons currently on screen, so a change in the saved set reaches them too. */
const watched = new Set();

function paintSaved(button) {
  const saved = keys.has(button.dataset.comboKey || '');
  button.textContent = saved ? 'Saved — show it' : 'Save this combination';
  button.classList.toggle('is-saved', saved);
  button.title = saved
    ? 'This combination is in the saved panel on the right. Click to open it there.'
    : 'Keep this combination in the saved panel on the right.';
}

/**
 * Start tracking a card's save button. From here on its label and its look are derived
 * from the saved set, so saving a mix in another mode, removing it, or reloading the
 * page all show up on buttons that are already on screen.
 */
export function watchSaved(button, space) {
  const key = comboKey(space && space.tags);
  if (!button || !key) return;
  button.dataset.comboKey = key;
  watched.add(button);
  paintSaved(button);
}

/** The save button every mode puts on its result cards. */
export function saveAction(space) {
  return {
    run: (target, button, card) => saveToVault(target, { button, card }),
    onCreate: (button) => watchSaved(button, space),
  };
}

/**
 * The button that asks about a whole combination — it pins the set and searches it — where the
 * tags on the card pin one tag each and wait. Every mode gets it from here, so the same click
 * carries the same words everywhere; and the words follow the tab the reader is standing in. From
 * another mode it is **Open in Finder**, because the click also moves them there; in the Finder
 * itself there is nothing to open, so the same button says **Search this combination**, which is
 * what it does. A saved row lives in all four tabs at once, so its label is repainted on the view
 * event rather than frozen when the row was built.
 */
let activeView = ((document.querySelector('.tab.is-active') || {}).dataset || {}).view || 'finder';

export function jumpLabel() {
  return activeView === 'finder' ? 'Search this combination' : 'Open in Finder';
}

export function comboJumpAction(space) {
  return {
    label: jumpLabel(),
    run: () => openInFinder(space.tags, { run: true }),
  };
}

function repaintJumpLabels() {
  const label = jumpLabel();
  for (const button of els.list.querySelectorAll('.vault-jump')) button.textContent = label;
}

function repaintSaved() {
  for (const button of watched) {
    // A card that has been thrown away is not worth tracking any more.
    if (!button.isConnected) watched.delete(button);
    else paintSaved(button);
  }
}

/* -------------------------------- the panel -------------------------------- */

function trackTopbar() {
  // The panel starts under the top bar, whose height is measured rather than assumed —
  // that is what lets the header grow taller on a phone at all.
  const paint = () => {
    document.documentElement.style.setProperty('--topbar-h', `${els.topbar.offsetHeight}px`);
  };
  paint();
  if ('ResizeObserver' in window) {
    const observe = new ResizeObserver(paint);
    observe.observe(els.topbar);
  } else {
    window.addEventListener('resize', paint, { passive: true });
  }
}

function paintOpen() {
  document.body.classList.toggle('vault-open', open);
  els.vault.classList.toggle('is-open', open);
  els.rail.setAttribute('aria-expanded', open ? 'true' : 'false');
  els.rail.title = open
    ? 'Saved combinations — click to close the panel'
    : 'Saved combinations — click to open the panel';
  if (open) {
    els.panel.hidden = false;
    els.panel.classList.remove('is-closing');
    observeRows();
  } else {
    els.panel.classList.add('is-closing');
    setTimeout(() => {
      els.panel.classList.remove('is-closing');
      if (!open) els.panel.hidden = true;
    }, 220);
  }
  try {
    window.localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* storage turned off: the panel simply starts closed next time */
  }
}

function setOpen(next) {
  if (next === open) return;
  open = next;
  paintOpen();
  uiBlip();
}

function rowFor(key) {
  return els.list.querySelector(`.vault-item[data-key="${CSS.escape(key)}"]`);
}

function restart(node, cls, ms) {
  node.classList.remove(cls);
  void node.offsetWidth; // forcing a reflow is what lets the same animation run twice
  node.classList.add(cls);
  setTimeout(() => node.classList.remove(cls), ms);
}

function paintCount() {
  els.count.textContent = String(spaces.length);
  els.sub.textContent = spaces.length === 1 ? '1 combination saved' : `${fmtInt(spaces.length)} combinations saved`;
}

function bumpCount() {
  restart(els.count, 'is-bump', 720);
}

function pulseRail(tier) {
  if (tier && tier.color) {
    els.rail.style.setProperty('--tier-color', tier.color);
    els.rail.style.setProperty('--tier-glow', tier.glow || tier.color);
  }
  restart(els.rail, 'is-pulse', 960);
}

function flagSaved(text) {
  els.flag.textContent = text;
  restart(els.flag, 'is-on', 1500);
}

/**
 * The part that makes the destination obvious: the saved mix itself flies across the
 * page into the panel's handle, which then flashes while its badge bumps.
 */
function flyToVault(source, tags, tier) {
  if (!source || !motionAllowed()) {
    landed(tier, 'saved here');
    return;
  }
  const from = source.getBoundingClientRect();
  const rail = els.rail.getBoundingClientRect();
  const width = Math.max(150, Math.min(from.width, 380));
  const left = Math.max(10, Math.min(from.left, window.innerWidth - width - 10));
  const top = Math.max(10, Math.min(from.top, window.innerHeight - 70));

  const token = el('div', { className: 'vault-fly' }, [
    el('span', { className: 'vault-fly-lead', text: 'saved' }),
    ...(tags || []).map((tag) => el('span', { className: 'vault-fly-tag', text: tag.name })),
  ]);
  if (tier) applyTier(token, tier);
  token.style.left = `${left}px`;
  token.style.top = `${top}px`;
  token.style.width = `${width}px`;
  document.body.append(token);

  const dx = rail.left + rail.width / 2 - (left + width / 2);
  const dy = rail.top + rail.height / 2 - (top + 22);
  const anim = token.animate([
    { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
    { transform: `translate3d(${dx * 0.45}px, ${dy * 0.5 - 38}px, 0) scale(0.68)`, opacity: 1, offset: 0.52 },
    { transform: `translate3d(${dx}px, ${dy}px, 0) scale(0.18)`, opacity: 0.2 },
  ], { duration: 780, easing: 'cubic-bezier(0.32, 0.02, 0.28, 1)', fill: 'forwards' });
  anim.onfinish = () => {
    token.remove();
    landed(tier, 'saved here');
  };
}

function landed(tier, flagText) {
  pulseRail(tier);
  bumpCount();
  flagSaved(flagText);
}

function flashRow(key) {
  const row = rowFor(key);
  if (!row) return;
  row.scrollIntoView({ block: 'nearest', behavior: motionAllowed() ? 'smooth' : 'auto' });
  restart(row, 'is-flash', 1300);
}

/** Clicking a save button for a mix that is already saved points at it instead. */
function revealSaved(key) {
  if (!open) setOpen(true);
  landed(null, 'already saved');
  requestAnimationFrame(() => flashRow(key));
}

/* ---------------------------------- saving --------------------------------- */

/**
 * The one way anything gets saved, from any of the four modes. It writes through the
 * same API the panel reads, then puts the row in the panel straight away, so the panel
 * is never a refresh behind what was just saved.
 */
export async function saveToVault(space, { button = null, card = null } = {}) {
  const tags = (space && space.tags) || [];
  const key = comboKey(tags);
  if (!key) return null;

  if (keys.has(key)) {
    revealSaved(key);
    return null;
  }

  if (button) {
    watchSaved(button, space); // from now on this button follows the saved set
    button.disabled = true;
    button.textContent = 'Saving…';
  }
  try {
    const out = await api.saveSpace(tags.map((t) => t.id));
    const saved = out.space || { id: null, tags, created_at: new Date().toISOString() };
    remember(saved, key); // remember() re-paints every tracked button, this one included
    flyToVault(card || button, tags, space.tier);
    if (open) flashRow(key);
    if (button) button.disabled = false;
    uiBlip();
    return saved;
  } catch (err) {
    if (button) {
      button.disabled = false;
      button.textContent = 'Could not save';
      button.title = err.message;
    }
    return null;
  }
}

function remember(space, key) {
  const at = spaces.findIndex((s) => comboKey(s.tags) === key);
  if (at >= 0) spaces[at] = space;
  else spaces.unshift(space);
  keys.set(key, space.id);
  paintCount();
  putRow(space);
  repaintSaved();
}

function putRow(space) {
  els.list.querySelector('.vault-empty')?.remove();
  const key = comboKey(space.tags);
  const node = rowNode(space);
  const existing = rowFor(key);
  if (existing) existing.replaceWith(node);
  else els.list.prepend(node);
  observeRows();
}

/* ---------------------------------- rows ----------------------------------- */

function miniButton(text, run, extraClass = '') {
  const btn = el('button', {
    className: extraClass ? `mini-btn ${extraClass}` : 'mini-btn',
    type: 'button',
    text,
  });
  btn.addEventListener('click', () => run());
  return btn;
}

function rowNode(space) {
  const key = comboKey(space.tags);
  const row = el('article', { className: 'vault-item', dataset: { key, id: String(space.id ?? '') } });

  // A tag here is a tag like anywhere else on the page: one click puts it in the Finder's tag
  // box, the next takes it out, and the gold mark follows the tag box rather than this row's
  // render — `main.js markEveryPickedChip` repaints every chip on the page whenever the box
  // changes, so clearing the tags in the Finder clears the mark here too. The whole saved
  // combination is a different question, and it has its own button below.
  const isPicked = (tag) => selectedTags().some((t) => t.id === tag.id);
  const tags = el('div', { className: 'tagline' }, (space.tags || []).map((tag) => tagChip(tag, {
    onClick: toggleTagInFinder,
    picked: isPicked(tag),
    syncPicked: isPicked,
  })));
  const badge = el('span', { className: 'vault-badge is-waiting', text: '…' });
  row.append(el('div', { className: 'vault-line' }, [tags, badge]));

  const metaBits = [`saved ${sinceLabel(space.created_at)}`];
  row.append(el('p', { className: 'vault-meta', text: metaBits.join(' · ') }));

  if ((space.unresolved || []).length) {
    const n = space.unresolved.length;
    row.append(el('p', {
      className: 'vault-meta vault-unresolved',
      text: `${n} saved tag${n === 1 ? ' is' : 's are'} no longer in the catalog.`,
    }));
  }

  row.append(el('div', { className: 'vault-games' }, [
    el('p', { className: 'vault-loading', text: 'Reading the catalog…' }),
  ]));

  if ((space.tags || []).length) {
    row.append(el('div', { className: 'vault-actions' }, [
      miniButton(jumpLabel(), () => openInFinder(space.tags, { run: true }), 'vault-jump'),
      miniButton('Remove', () => removeSpace(space, row), 'vault-del'),
    ]));
  }

  const known = details.get(key);
  if (known) paintGames(row, known);
  else row.dataset.needsGames = '1';
  return row;
}

async function removeSpace(space, row) {
  const key = comboKey(space.tags);
  const button = row.querySelector('.vault-del');
  if (button) {
    button.disabled = true;
    button.textContent = 'Removing…';
  }
  try {
    await api.deleteSpace(space.id);
  } catch (err) {
    if (button) {
      button.disabled = false;
      button.textContent = 'Could not remove';
      button.title = err.message;
    }
    return;
  }

  spaces = spaces.filter((s) => comboKey(s.tags) !== key);
  keys.delete(key);
  details.delete(key);
  repaintSaved(); // buttons that were showing this one as saved go back to "Save this combination"
  row.classList.add('is-going');
  const finish = () => {
    row.remove();
    paintCount();
    bumpCount();
    if (!spaces.length) paintEmpty();
  };
  if (motionAllowed()) setTimeout(finish, 240);
  else finish();
  uiBlip();
}

/* ----------------------- games, read only for visible rows ------------------ */

function observeRows() {
  if (!open) return; // nothing is on screen to fill while the panel is closed
  const waiting = [...els.list.querySelectorAll('.vault-item[data-needs-games]')];
  if (!waiting.length) return;
  if (!('IntersectionObserver' in window)) {
    for (const row of waiting) fillGames(row);
    return;
  }
  if (!loader) {
    loader = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        loader.unobserve(entry.target);
        fillGames(entry.target);
      }
    }, { root: els.list, rootMargin: '160px' });
  }
  for (const row of waiting) loader.observe(row);
}

async function fillGames(row) {
  const key = row.dataset.key || '';
  const space = spaces.find((s) => comboKey(s.tags) === key);
  row.removeAttribute('data-needs-games');
  if (!space) return;

  const known = details.get(key);
  if (known) {
    paintGames(row, known);
    return;
  }
  if (!(space.tags || []).length) {
    paintGames(row, { count: 0, tier: null, games: [], total: 0, broken: true });
    return;
  }

  try {
    const ids = space.tags.map((t) => t.id);
    const out = await api.combo(ids, { limit: GAMES_SHOWN, variants: 0 });
    const combo = out.combo || {};
    const info = {
      count: Number(combo.count) || 0,
      tier: combo.tier || null,
      games: combo.games || [],
      total: Number(combo.count) || 0,
      ids,
    };
    details.set(key, info);
    if (row.isConnected) paintGames(row, info);
  } catch (err) {
    const host = row.querySelector('.vault-games');
    if (host) clear(host).append(el('p', { className: 'vault-loading', text: `The catalog could not be read for this one: ${err.message}` }));
  }
}

function paintGames(row, info) {
  if (info.tier) applyTier(row, info.tier);

  const badge = row.querySelector('.vault-badge');
  if (badge) {
    badge.classList.remove('is-waiting');
    if (info.broken) badge.textContent = 'tags gone';
    else {
      badge.textContent = info.count === 0
        ? 'no games'
        : `${fmtInt(info.count)} ${plural(info.count, 'game')}`;
      badge.title = info.tier ? `${info.tier.name}: ${info.tier.blurb}` : '';
    }
  }

  const host = row.querySelector('.vault-games');
  if (!host) return;
  clear(host);

  if (info.broken) {
    host.append(el('p', { className: 'vault-loading', text: 'None of the saved tags are in the catalog any more.' }));
    return;
  }
  if (!info.games.length) {
    host.append(el('p', { className: 'vault-none', text: 'No game in the catalog has this combination — which is why it is worth keeping.' }));
    return;
  }
  for (const game of info.games) host.append(gameRow(game));
  // The same control the cards and both boards use, so a saved row grows its games the way
  // every other list on the page does — and shows no control at all when nothing is held back.
  // The row's cache grows with each page, so re-rendering the panel keeps what the reader opened.
  paintMoreControl(host, { shown: info.games.length, total: info.total }, {
    pageSize: GAMES_SHOWN,
    unit: 'game',
    render: gameRow,
    load: async (offset, take) => {
      const out = await api.combo(info.ids, { limit: take, offset, variants: 0 });
      const games = ((out.combo || {}).games) || [];
      info.games = info.games.concat(games);
      return { items: games };
    },
  });
}

/* --------------------------------- loading --------------------------------- */

function paintEmpty() {
  els.list.append(el('p', {
    className: 'vault-empty',
    text: 'Nothing saved yet. Every mode has a save button on its results.',
  }));
}

function renderAll() {
  clear(els.list);
  paintCount();
  if (!spaces.length) {
    paintEmpty();
    return;
  }
  for (const space of spaces) els.list.append(rowNode(space));
  observeRows();
}

async function load() {
  try {
    const out = await api.spaces();
    spaces = out.spaces || [];
    keys.clear();
    details.clear();
    for (const space of spaces) keys.set(comboKey(space.tags), space.id);
    renderAll();
    repaintSaved();
  } catch (err) {
    clear(els.list).append(el('p', { className: 'vault-empty', text: `Saved combinations could not be read: ${err.message}` }));
    els.sub.textContent = 'not available';
  }
}

/* --------------------------------- wiring ---------------------------------- */

export function initVault() {
  trackTopbar();
  els.rail.addEventListener('click', () => setOpen(!open));
  els.collapse.addEventListener('click', () => setOpen(false));
  // A saved row is on screen in all four tabs, so its jump button follows the tab the reader is
  // standing in: once they are in the Finder, there is no Finder left to open.
  window.addEventListener('steamtage:view', (event) => {
    activeView = event.detail.view;
    repaintJumpLabels();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !open) return;
    const node = document.activeElement;
    if (node && ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)) return;
    setOpen(false);
  });

  let remembered = '0';
  try {
    remembered = window.localStorage.getItem(OPEN_KEY) || '0';
  } catch {
    /* storage turned off */
  }
  if (remembered === '1') {
    open = true;
    paintOpen(); // restored, not clicked: no blip
  }

  return { ready: () => load(), load, isOpen: () => open };
}
