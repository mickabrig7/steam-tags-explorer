/* Small synthesised sound kit: no audio files, just oscillators.
   Every tier gets its own chord so rarity is audible as well as visible. */

const STORAGE_KEY = 'steamtage.muted';

// Keyed by band id, rarest first: an Empty draw rings highest and shimmers, a Very
// common one sits low and dry. Keep the rows in step with public/engine/tiers.js.
const VOICES = {
  empty: { notes: [329.6, 415.3, 493.9, 659.3], wave: 'sine', gain: 0.16, spread: 0.16, shimmer: true },
  almost_empty: { notes: [293.7, 370, 440, 587.3], wave: 'triangle', gain: 0.18, spread: 0.14, shimmer: true },
  very_rare: { notes: [246.9, 311.1, 370, 466.2], wave: 'sawtooth', gain: 0.12, spread: 0.12, shimmer: false },
  rare: { notes: [220, 277.2, 329.6, 415.3], wave: 'triangle', gain: 0.14, spread: 0.12, shimmer: true },
  uncommon: { notes: [196, 246.9, 293.7, 349.2], wave: 'triangle', gain: 0.14, spread: 0.1, shimmer: false },
  fairly_common: { notes: [174.6, 220, 261.6], wave: 'sine', gain: 0.13, spread: 0.09, shimmer: false },
  common: { notes: [146.8, 185, 220], wave: 'sine', gain: 0.12, spread: 0.08, shimmer: false },
  very_common: { notes: [110, 138.6, 164.8], wave: 'sine', gain: 0.11, spread: 0.07, shimmer: false },
};

let audio = null;
let master = null;
let muted = localStorage.getItem(STORAGE_KEY) === '1';

function ensureAudio() {
  if (audio) return audio;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    audio = new Ctor();
    master = audio.createGain();
    master.gain.value = 0.6;
    master.connect(audio.destination);
  } catch {
    audio = null;
    return null;
  }
  return audio;
}

// Browsers refuse to start audio until the person has actually interacted with the
// page, so until then we stay quiet instead of queueing sounds that never play.
let gestured = false;
for (const kind of ['pointerdown', 'keydown']) {
  window.addEventListener(kind, () => { gestured = true; ready(); }, { once: true });
}

function ready() {
  if (muted) return null;
  const context = ensureAudio();
  if (!context) return null;
  if (context.state === 'suspended') {
    if (!gestured) return null;
    context.resume().catch(() => {});
  }
  return context;
}

export function isMuted() {
  return muted;
}

export function setMuted(next) {
  muted = Boolean(next);
  localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
  if (!muted) ready();
  return muted;
}

export function toggleMuted() {
  return setMuted(!muted);
}

/** The clack of the reel passing a slot. */
export function reelTick(intensity = 1) {
  const context = ready();
  if (!context) return;
  const now = context.currentTime;
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(900 + intensity * 260, now);
  osc.frequency.exponentialRampToValueAtTime(360, now + 0.05);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.05 * intensity, now + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  osc.connect(gain).connect(master);
  osc.start(now);
  osc.stop(now + 0.1);
}

/** Low rumble while the crate shakes. */
export function crateRumble(duration = 1.2) {
  const context = ready();
  if (!context) return;
  const now = context.currentTime;
  const osc = context.createOscillator();
  const gain = context.createGain();
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 220;
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(48, now);
  osc.frequency.linearRampToValueAtTime(70, now + duration);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.12, now + 0.25);
  gain.gain.linearRampToValueAtTime(0.0001, now + duration);
  osc.connect(filter).connect(gain).connect(master);
  osc.start(now);
  osc.stop(now + duration + 0.05);
}

/** Lid pop: a short rising whoosh. */
export function cratePop() {
  const context = ready();
  if (!context) return;
  const now = context.currentTime;
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(180, now);
  osc.frequency.exponentialRampToValueAtTime(1400, now + 0.28);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.18, now + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
  osc.connect(gain).connect(master);
  osc.start(now);
  osc.stop(now + 0.45);
}

/** The reward chord. Rarer tiers get more notes, more shimmer, more time. */
export function revealChord(tierId) {
  const context = ready();
  if (!context) return;
  const voice = VOICES[tierId] || VOICES.common;
  const now = context.currentTime;

  for (const [index, note] of voice.notes.entries()) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = voice.wave;
    const start = now + index * voice.spread;
    osc.frequency.setValueAtTime(note, start);
    if (voice.shimmer) osc.detune.setValueAtTime((index - 1) * 6, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(voice.gain, start + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + (voice.shimmer ? 1.5 : 0.9));
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + 1.8);
  }

  if (voice.shimmer) {
    const sparkle = context.createOscillator();
    const sparkleGain = context.createGain();
    sparkle.type = 'sine';
    sparkle.frequency.setValueAtTime(voice.notes[voice.notes.length - 1] * 2, now + 0.2);
    sparkleGain.gain.setValueAtTime(0.0001, now + 0.2);
    sparkleGain.gain.linearRampToValueAtTime(0.07, now + 0.28);
    sparkleGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.7);
    sparkle.connect(sparkleGain).connect(master);
    sparkle.start(now + 0.2);
    sparkle.stop(now + 1.8);
  }
}

/** Interface blip for ordinary presses. */
export function uiBlip() {
  const context = ready();
  if (!context) return;
  const now = context.currentTime;
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(660, now);
  osc.frequency.exponentialRampToValueAtTime(880, now + 0.07);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.05, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
  osc.connect(gain).connect(master);
  osc.start(now);
  osc.stop(now + 0.2);
}
