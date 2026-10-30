/* Confetti + screen flash. Both stand down when the visitor asks for less motion. */

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export function motionAllowed() {
  return !reduceMotion.matches;
}

let canvas = null;
let ctx = null;
let particles = [];
let frame = null;

function ensureCanvas() {
  if (canvas) return true;
  canvas = document.getElementById('confetti');
  if (!canvas) return false;
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize, { passive: true });
  return true;
}

function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * ratio);
  canvas.height = Math.floor(window.innerHeight * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

/**
 * A burst of coloured cards from the middle of the screen. `colors` come straight
 * from the tier palette, so a Very rare draw visibly differs from a Very common one.
 */
export function celebrate({ colors = ['#f7ce46', '#e457b1', '#64f5c8'], power = 1, origin = { x: 0.5, y: 0.42 } } = {}) {
  if (!motionAllowed()) return;
  if (!ensureCanvas()) return;

  const width = window.innerWidth;
  const height = window.innerHeight;
  const cx = width * origin.x;
  const cy = height * origin.y;
  const count = Math.round(46 * power);

  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
    const speed = (240 + Math.random() * 460) * power;
    particles.push({
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 5 + Math.random() * 8,
      h: 3 + Math.random() * 5,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 12,
      color: colors[i % colors.length],
      life: 1.1 + Math.random() * 0.8,
    });
  }

  if (!frame) frame = requestAnimationFrame(step);
}

let last = 0;
function step(now) {
  const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
  last = now;

  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  for (const p of particles) {
    p.life -= dt;
    p.vy += 900 * dt;
    p.vx *= 0.99;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rotation += p.spin * dt;

    if (p.life <= 0) continue;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rotation);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }

  particles = particles.filter((p) => p.life > 0 && p.y < window.innerHeight + 60);
  if (particles.length) {
    frame = requestAnimationFrame(step);
  } else {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    frame = null;
    last = 0;
  }
}

/** One wash of tier-coloured light over the whole page. */
export function flash(glow, ms = 260) {
  const node = document.getElementById('flash');
  if (!node || !motionAllowed()) return;
  node.style.setProperty('--tier-glow', glow);
  node.classList.add('is-on');
  setTimeout(() => node.classList.remove('is-on'), ms);
}

/**
 * Bring into view the thing the reader just caused — the reel when a crate opens, the board when a
 * search answers — and only when it is genuinely out of reach. Two conditions hold the page still: the
 * target's **own top edge** sits between the sticky top bar and the bottom of the viewport, **and** at
 * least `minVisible` px of it are showing below that bar. So a board the reader is already reading from
 * its first card is not moved, a card's worth of peek at the bottom of a tall screen is not treated as
 * "visible", and a reader who was deep inside the previous board is brought back to the first card of the
 * new one. Paging a board that is already open never calls this at all.
 *
 * A reveal block is still growing when this fires — its games and its side blocks land just after the
 * scroll is issued — so the position it was measured from shifts a little under the page and the landing
 * ends up behind the bar. Once the motion has settled, a target that has slid **up to about 120 px**
 * behind the bar is taken back once; a bigger gap means the first scroll is still travelling, and a
 * page that is mid-flight gets no second push. The targets reserve room for that bar with
 * `scroll-margin-top` in `styles.css`, which is what lets `block: 'start'` land them where they read.
 * (The landing can also come up short: a search clears its board first, which shortens the document and
 * clamps the scroll, so the rule is that the answer's top edge ends up on screen, not pinned to an offset.)
 */
export function scrollToInterest(node, { block = 'start', minVisible = 200 } = {}) {
  if (!node || !node.isConnected) return;
  const behavior = motionAllowed() ? 'smooth' : 'auto';
  const barH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 0;
  const inHand = () => {
    const rect = node.getBoundingClientRect();
    const viewH = window.innerHeight || document.documentElement.clientHeight;
    if (rect.top < barH() || rect.top >= viewH) return false;
    // A target that has no height yet — a reveal block at the instant it is created — has nothing to
    // show, so it is never in hand.
    const need = Math.min(rect.height, minVisible);
    return need > 0 && Math.min(rect.bottom, viewH) - rect.top >= need;
  };
  if (inHand()) return;
  node.scrollIntoView({ behavior, block, inline: 'nearest' });
  setTimeout(() => {
    if (!node.isConnected) return;
    const slip = barH() - node.getBoundingClientRect().top;
    if (slip <= 6 || slip > 120) return;
    node.scrollIntoView({ behavior, block, inline: 'nearest' });
  }, 360);
}
