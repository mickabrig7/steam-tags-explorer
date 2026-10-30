/* App shell: tab router, catalog chip, and the shared tag selection.
 *
 * The page answers itself: the engine runs here (see `js/local-api.js`) against the
 * catalog snapshot fetched at boot, so there is no server between a press and an
 * answer, and nothing here depends on which file that catalog came from. */

import { api, configureLocalEngine, describeIndex } from './local-api.js';
import { loadCatalogSnapshot } from './browser-index.js';
import { caseLegend, clear, el, emptyState, fmtInt, rarityLegend } from './ui.js';
import { markRarityLegend } from './rarity.js';
import { isMuted, toggleMuted, uiBlip } from './sound.js';
import { initFinder } from './finder.js';
import { initCrate } from './crate.js';
import { initDraft } from './draft.js';
import { initUncharted } from './uncharted.js';
import { initVault } from './vault.js';

const MAX_TAGS = 5;

const views = {
  finder: document.getElementById('view-finder'),
  crate: document.getElementById('view-crate'),
  draft: document.getElementById('view-draft'),
  uncharted: document.getElementById('view-uncharted'),
};
const tabs = [...document.querySelectorAll('.tab')];

/* ---------------------------------- boot ----------------------------------
 * The catalog is one ~7 MB file, and nothing on the page can answer a press until that file has been
 * read and indexed here in the browser. Until then the panels are hidden rather than left looking
 * usable, and this block carries the status: bytes down, then unpacking and indexing.
 *
 * It lives here rather than behind a widget because it is the only thing the page shows before there
 * is a page: three elements, one class on <html>, and the same numbers the top-bar chip ends up
 * quoting. `index.html` writes `is-booting` so the first painted frame is already gated, and the tab
 * buttons are disabled below, before the first await, so a keyboard user cannot reach a panel that
 * has no index behind it. */

const boot = {
  root: document.documentElement,
  block: document.getElementById('boot'),
  status: document.getElementById('bootStatus'),
  fill: document.getElementById('bootFill'),
  retry: document.getElementById('bootRetry'),
};

/** Two significant figures: enough to read at a glance while the bytes are still arriving. */
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  const mb = n / (1024 * 1024);
  return mb >= 10 ? `${mb.toFixed(0)} MB` : `${mb.toFixed(1)} MB`;
}

function bootSay(text, { fraction = null, busy = false, failed = false } = {}) {
  if (boot.status) boot.status.textContent = text;
  if (boot.block) {
    boot.block.classList.toggle('is-busy', busy);
    boot.block.classList.toggle('is-failed', failed);
    boot.block.setAttribute('aria-busy', failed ? 'false' : 'true');
  }
  if (boot.fill) boot.fill.style.width = fraction === null ? '' : `${Math.round(fraction * 100)}%`;
}

function bootProgress({ stage, bytes = 0, total = 0 }) {
  if (stage === 'index') {
    bootSay(`Unpacking and indexing the catalog — ${fmtBytes(bytes)} downloaded`, { busy: true });
    return;
  }
  if (!total) {
    // A host that sends no Content-Length still gets an honest line, just no percentage to draw.
    bootSay(`Downloading the catalog — ${fmtBytes(bytes)} so far`, { busy: true });
    return;
  }
  bootSay(`Downloading the catalog — ${fmtBytes(bytes)} of ${fmtBytes(total)}`, {
    fraction: Math.min(1, bytes / total),
  });
}

function bootDone() {
  boot.root.classList.remove('is-booting');
  if (boot.block) boot.block.setAttribute('aria-busy', 'false');
  for (const tab of tabs) tab.disabled = false;
}

function bootFailed(message) {
  bootSay(`The catalog did not load: ${message}`, { failed: true });
  if (boot.retry) {
    boot.retry.hidden = false;
    boot.retry.addEventListener('click', () => window.location.reload(), { once: true });
  }
}

for (const tab of tabs) tab.disabled = true;

const ctx = {
  api,
  meta: null,
  tiers: [],
  tierById: new Map(),
  selected: [],
};

/* ------------------------------- shared state ------------------------------ */

export function selectedTags() {
  return ctx.selected;
}

/** Replace the tag selection, keeping at most as many tags as a combination may hold. */
export function setSelected(tags) {
  const next = [];
  for (const tag of tags || []) {
    const id = typeof tag === 'number' ? tag : tag.id;
    if (id === undefined || id === null) continue;
    if (next.some((t) => t.id === id)) continue;
    next.push(typeof tag === 'number' ? { id, name: tag, games: 0 } : tag);
    if (next.length >= MAX_TAGS) break;
  }
  ctx.selected = next;
  renderChips();
  return ctx.selected;
}

export function addSelected(tag) {
  const id = typeof tag === 'number' ? tag : tag.id;
  if (ctx.selected.some((t) => t.id === id)) return ctx.selected;
  if (ctx.selected.length >= MAX_TAGS) return ctx.selected;
  ctx.selected.push(typeof tag === 'number' ? { id, name: tag, games: 0 } : tag);
  renderChips();
  return ctx.selected;
}

export function removeSelected(tag) {
  const id = typeof tag === 'number' ? tag : tag.id;
  ctx.selected = ctx.selected.filter((t) => t.id !== id);
  renderChips();
  return ctx.selected;
}

/** Jump to the Finder with a mix already picked — used by Crate and Uncharted. */
export function openInFinder(tags, { run = true } = {}) {
  const picked = [];
  for (const tag of tags || []) {
    const node = typeof tag === 'number' ? { id: tag, name: `tag ${tag}`, games: 0 } : tag;
    if (!Number.isFinite(node.id)) continue;
    if (picked.some((t) => t.id === node.id)) continue;
    picked.push(node);
    if (picked.length >= MAX_TAGS) break;
  }
  setSelected(picked);
  document.getElementById('finderK').value = String(Math.max(2, Math.min(MAX_TAGS, picked.length)));
  showView('finder');
  if (run) window.dispatchEvent(new CustomEvent('steamtage:run-finder'));
}

/**
 * A tag chip on a card is one tag, so one click puts that tag in the tag box and the next click
 * takes it back out — the same switch the Finder's own cards offer, in every mode and in the
 * saved panel. The Finder opens with the box showing the change and waits there: nothing is
 * searched until the button is pressed, and *Tags per combination* is only ever raised to fit
 * what the box holds, never lowered, so a length the reader chose survives.
 */
export function toggleTagInFinder(tag) {
  const node = typeof tag === 'number' ? { id: tag, name: `tag ${tag}`, games: 0 } : tag;
  if (!node || !Number.isFinite(node.id)) return;
  const picked = selectedTags();
  if (picked.some((t) => t.id === node.id)) {
    removeSelected(node);
  } else if (picked.length >= MAX_TAGS) {
    // A box that is already full is the one outcome worth saying out loud. The Finder opens to
    // show the reason, rather than the click vanishing into another tab.
    showView('finder');
    announceTags({ note: `A combination holds at most ${MAX_TAGS} tags. Take one out before adding ${node.name}.` });
    return;
  } else {
    addSelected(node);
  }
  const k = document.getElementById('finderK');
  const needed = Math.min(MAX_TAGS, Math.max(2, selectedTags().length));
  if (Number(k.value) < needed) k.value = String(needed);
  showView('finder');
}

/* ---------------------------------- chips ---------------------------------- */
function renderChips() {
  const host = document.getElementById('chips');
  clear(host);
  if (!ctx.selected.length) {
    host.append(el('span', { className: 'chips-empty', text: 'No tags picked yet.' }));
  } else {
    for (const tag of ctx.selected) {
      host.append(el('span', { className: 'chip' }, [
        el('span', { text: tag.name }),
        el('span', { className: 'num', text: Number.isFinite(tag.games) && tag.games ? `${fmtInt(tag.games)} games` : '' }),
        el('button', { type: 'button', 'aria-label': `Remove ${tag.name}`, text: '×' }),
      ]));
      host.lastChild.querySelector('button').addEventListener('click', () => {
        removeSelected(tag);
        uiBlip();
      });
    }
  }
  markEveryPickedChip();
  announceTags();
}

/**
 * A tag chip anywhere on the page — a result card in any mode, a saved row — carries its own tag
 * id, so the tag box is the single answer to "is this one picked?". Repainting them all on every
 * change is what keeps a saved row honest after the Finder clears the tag, or a card in another
 * tab honest after a chip here picked it up: the gold mark follows the box, never the render.
 */
function markEveryPickedChip() {
  const picked = new Set(ctx.selected.map((t) => t.id));
  for (const chip of document.querySelectorAll('.chip-ghost[data-tag]')) {
    chip.classList.toggle('is-picked', picked.has(Number(chip.dataset.tag)));
  }
}

/**
 * Every panel that reports on the tag box listens here, so a change made in one place is told to
 * the others without any of them having to ask. `note` is what a panel should say instead of its
 * usual "the tags changed" line — the case being a box that is already full.
 */
function announceTags(detail = {}) {
  window.dispatchEvent(new CustomEvent('steamtage:tags', { detail }));
}

/* --------------------------------- routing --------------------------------- */

function showView(name) {
  // `hidden` is all a panel needs; `aria-selected` belongs to the tab, not the panel.
  for (const [key, node] of Object.entries(views)) {
    node.hidden = key !== name;
  }
  for (const tab of tabs) {
    const active = tab.dataset.view === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  window.dispatchEvent(new CustomEvent('steamtage:view', { detail: { view: name } }));
}

/* --------------------------------- catalog --------------------------------- */

export function sinceLabel(iso) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso.slice(0, 10);
  const days = Math.max(0, Math.round((Date.now() - then) / 86_400_000));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 31) return `${days} days ago`;
  return iso.slice(0, 10);
}

/**
 * Boot step one: fetch and build the index. The chip and the boot block both say what is happening,
 * because the download is the one part of opening the page that is not instant.
 */
async function loadIndex() {
  const chip = document.getElementById('libraryMeta');
  chip.textContent = 'Loading the catalog…';
  bootSay('Connecting to the catalog…', { busy: true });
  const snapshot = await loadCatalogSnapshot({
    log: (m) => console.log(`[index] ${m}`),
    progress: bootProgress,
  });
  configureLocalEngine(snapshot);
  console.log(`[index] ${describeIndex()}`);
  return snapshot;
}

async function loadMeta() {
  try {
    ctx.meta = await ctx.api.meta();
    ctx.tiers = ctx.meta.tiers || [];
    ctx.tierById = new Map(ctx.tiers.map((t) => [t.id, t]));
    const chip = document.getElementById('libraryMeta');
    chip.innerHTML = `<b>${fmtInt(ctx.meta.games)}</b> games · <b>${fmtInt(ctx.meta.tags)}</b> tags · updated ${sinceLabel(ctx.meta.last_sync)}`;
    paintLegends();
  } catch (err) {
    document.getElementById('libraryMeta').textContent = `Catalog unavailable: ${err.message}`;
  }
}

/**
 * The two reference blocks. The rarity block — every band, its colour and the exact count it
 * means — sits in the column to the right of the settings in all four modes: the same block, the
 * same place, four times, and in the Missed opportunities panel the Empty row is marked because
 * that is the band the mode promises. The crate block belongs to the one panel that picks a crate
 * and sits above its settings, beside the field it explains. Both come from `/api/meta`, which is
 * how a panel keeps its own words short and can never disagree with the server.
 */
const LEGEND_TARGETS = [
  { host: 'legendRarityFinder', control: 'finderRarity' },
  { host: 'legendRarityCrate', control: 'crateRarity' },
  { host: 'legendRarityDraft', control: 'draftRarity' },
  { host: 'legendRaritySpace', band: 'empty' },
];
const CASE_LEGEND_HOSTS = ['legendCaseCrate'];

function paintLegends() {
  for (const target of LEGEND_TARGETS) {
    const host = document.getElementById(target.host);
    if (!host) continue;
    clear(host).append(rarityLegend(ctx.tiers));
    const control = target.control ? document.getElementById(target.control) : null;
    markRarityLegend(host, control ? control.value : target.band);
  }
  for (const id of CASE_LEGEND_HOSTS) {
    const host = document.getElementById(id);
    if (host) clear(host).append(caseLegend((ctx.meta && ctx.meta.cases) || []));
  }
}

/* --------------------------------- startup --------------------------------- */

async function main() {
  renderChips();
  await loadIndex();
  await loadMeta();

  for (const tab of tabs) tab.addEventListener('click', () => {
    uiBlip();
    showView(tab.dataset.view);
  });

  const finder = initFinder(ctx);
  const crate = initCrate(ctx);
  const draft = initDraft(ctx);
  const uncharted = initUncharted(ctx);
  // The saved panel outlives every mode: it is the one place saved combinations go.
  const vault = initVault(ctx);

  const soundBtn = document.getElementById('soundBtn');

  const paintSound = () => {
    soundBtn.textContent = isMuted() ? 'Sound off' : 'Sound on';
    soundBtn.setAttribute('aria-pressed', isMuted() ? 'false' : 'true');
  };
  paintSound();
  soundBtn.addEventListener('click', () => {
    toggleMuted();
    paintSound();
    if (!isMuted()) uiBlip();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== document.getElementById('tagInput')) {
      event.preventDefault();
      showView('finder');
      document.getElementById('tagInput').focus();
    }
  });

  finder.ready();
  crate.ready();
  draft.ready();
  uncharted.ready();
  vault.ready();

  // Only now does the page become interactive: every panel is wired, its empty state is written, and
  // the index behind it answers. Until this line the panels were hidden and the tabs disabled.
  bootDone();
}

main().catch((err) => {
  console.error(err);
  document.getElementById('libraryMeta').textContent = `Could not load the catalog: ${err.message}`;
  // A failure before the panels were ever shown is reported where the reader is looking — the boot
  // block, with a way to try again — rather than into a results host they have not seen yet.
  if (document.documentElement.classList.contains('is-booting')) {
    bootFailed(err.message);
    return;
  }
  const host = document.getElementById('finderResults');
  host.replaceChildren(emptyState(`The page could not start: ${err.message}`, true));
});
