import { $, api } from './util.js';
import { checkAwards } from './awards.js';

/*
 * Rig appearance. A rig is a small record of whitelisted options; the look comes
 * from data-* attributes on .bench (and on the read-only preview) styled in CSS.
 * Claimed callsigns keep it on the server, guests in this browser.
 */

const GUEST_KEY = 'cw-rig-v1';
const MAX_TAPES = 3;
const TAPE_PATTERN = /^[A-Za-z0-9 /.,?!+-]{1,10}$/;

export const ORIGINAL = {
  face: 'matte', dial: 'green', knob: 'ribbed', meter: 'black', backlight: false, tapes: [],
};

export const PRESETS = {
  'Brushed aluminium': { face: 'brushed', dial: 'amber', knob: 'black-silver', meter: 'cream', backlight: true },
  'Charcoal LCD': { face: 'charcoal', dial: 'green', knob: 'ribbed', meter: 'black', backlight: false },
  'Vintage desktop': { face: 'vintage', dial: 'amber', knob: 'bakelite', meter: 'cream', backlight: true },
};

export const CHOICES = {
  face: ['matte', 'brushed', 'charcoal', 'vintage', 'navy', 'olive', 'carbon', 'maroon', 'sand', 'teal', 'blueprint'],
  dial: ['green', 'amber', 'ice', 'violet', 'red', 'white', 'blue', 'mint'],
  knob: ['black-silver', 'ribbed', 'bakelite', 'chrome', 'brass', 'copper', 'gold', 'blue', 'titanium', 'red', 'smoke'],
  meter: ['black', 'cream', 'amber', 'ivory', 'mono', 'sunset', 'night'],
};

const claimed = document.body.dataset.claimed === '1';
const listeners = new Set();
let saved = load();

/** Returns a clean copy of any rig-shaped value; unknown options fall back to the original look. */
export function clean(input) {
  const rig = structuredClone(ORIGINAL);
  if (!input || typeof input !== 'object') return rig;
  for (const [key, allowed] of Object.entries(CHOICES)) {
    if (allowed.includes(input[key])) rig[key] = input[key];
  }
  rig.backlight = input.backlight === true;
  if (Array.isArray(input.tapes)) {
    for (const tape of input.tapes.slice(0, MAX_TAPES)) {
      const x = Math.round(+tape?.x), y = Math.round(+tape?.y);
      if (typeof tape?.t === 'string' && TAPE_PATTERN.test(tape.t) && x >= 0 && x <= 100 && y >= 0 && y <= 100) {
        rig.tapes.push({ t: tape.t, x, y });
      }
    }
  }
  return rig;
}

function load() {
  try {
    if (claimed) return clean(JSON.parse(document.body.dataset.rig || 'null'));
    return clean(JSON.parse(localStorage.getItem(GUEST_KEY)));
  } catch {
    return clean(null);
  }
}

export const savedRig = () => structuredClone(saved);
export const onRigChange = fn => listeners.add(fn);

/** Sets the look attributes on .bench or on a preview container. */
export function applyLook(element, rig) {
  for (const key of Object.keys(CHOICES)) element.dataset[key] = rig[key];
  element.dataset.backlight = String(rig.backlight);
}

/** Draws the tape captions into a container. Editable ones can be dragged by the caller. */
export function drawTapes(container, rig, onMove) {
  container.replaceChildren(...rig.tapes.map((tape, index) => {
    const label = document.createElement('span');
    label.className = 'tape';
    label.textContent = tape.t;
    label.style.left = tape.x + '%';
    label.style.top = tape.y + '%';
    label.style.setProperty('--tilt', ((index * 37 % 7) - 3) * .6 + 'deg');
    if (onMove) {
      label.tabIndex = 0;
      label.setAttribute('role', 'button');
      label.setAttribute('aria-label', `Caption ${tape.t}. Drag or use arrow keys to move.`);
      makeMovable(label, container, index, onMove);
    }
    return label;
  }));
}

function makeMovable(label, container, index, onMove) {
  const set = (x, y) => {
    x = Math.min(100, Math.max(0, Math.round(x)));
    y = Math.min(100, Math.max(0, Math.round(y)));
    label.style.left = x + '%';
    label.style.top = y + '%';
    onMove(index, x, y);
  };
  const position = () => [parseFloat(label.style.left), parseFloat(label.style.top)];

  label.addEventListener('pointerdown', event => {
    event.preventDefault();
    label.setPointerCapture(event.pointerId);
    label.classList.add('moving');
  });
  label.addEventListener('pointermove', event => {
    if (!label.hasPointerCapture(event.pointerId)) return;
    const rect = container.getBoundingClientRect();
    set((event.clientX - rect.left) / rect.width * 100, (event.clientY - rect.top) / rect.height * 100);
  });
  label.addEventListener('pointerup', () => label.classList.remove('moving'));
  label.addEventListener('keydown', event => {
    event.stopPropagation();
    const moves = { ArrowLeft: [-2, 0], ArrowRight: [2, 0], ArrowUp: [0, -2], ArrowDown: [0, 2] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const [x, y] = position();
    set(x + move[0], y + move[1]);
  });
}

/** Shows a rig on the live station. Everything that draws the rig goes through here. */
export function showRig(rig) {
  applyLook($('bench'), rig);
  for (const container of document.querySelectorAll('[data-tapes]')) drawTapes(container, rig);
  for (const fn of listeners) fn(rig);
}

export async function saveRig(rig) {
  rig = clean(rig);
  if (claimed) {
    await api('rig_save', { post: { rig } });
    checkAwards();
  } else localStorage.setItem(GUEST_KEY, JSON.stringify(rig));
  saved = rig;
  return rig;
}

export const initRigStyle = () => showRig(saved);
