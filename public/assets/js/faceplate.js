import { receiveLevel } from './rig.js';
import { isKeyDown } from './keyer.js';

/*
 * The strip under the display: an embossed callsign label and a small analogue meter.
 * Receiving, the needle shows the simulated receive level (noise plus the signals that
 * get through the filter). Keying, it follows the local key with a damped spring.
 * The scale is relative: it reads REL on receive and TX while keying, not S-units or watts.
 */

const SVG = 'http://www.w3.org/2000/svg';
const PIVOT = { x: 50, y: 50 };
const NEEDLE = 38;
const SWEEP = 100;               // degrees, centred on vertical
const KEYED_LEVEL = .82;
const STIFFNESS = 300;
const DAMPING = 24;

const needles = [];
const modeLabels = [];
let value = 0, velocity = 0, lastFrame = 0, lastTx = null;

function svg(name, attrs = {}) {
  const node = document.createElementNS(SVG, name);
  for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, val);
  return node;
}

const angleFor = level => (level - .5) * SWEEP;

function buildMeter(live = true) {
  const meter = svg('svg', { viewBox: '0 0 100 56', class: 'meter', role: 'img', 'aria-label': 'Relative level meter' });
  meter.append(svg('rect', { class: 'm-face', x: 1, y: 1, width: 98, height: 54, rx: 5 }));

  for (let i = 0; i <= 10; i++) {
    const major = i % 5 === 0;
    const inner = NEEDLE - (major ? 7 : 4);
    const dx = Math.sin((angleFor(i / 10)) * Math.PI / 180);
    const dy = -Math.cos((angleFor(i / 10)) * Math.PI / 180);
    meter.append(svg('line', {
      class: major ? 'm-tick major' : 'm-tick',
      x1: PIVOT.x + dx * inner, y1: PIVOT.y + dy * inner,
      x2: PIVOT.x + dx * (NEEDLE + 2), y2: PIVOT.y + dy * (NEEDLE + 2),
    }));
  }

  const mode = svg('text', { class: 'm-text', x: 8, y: 49 });
  mode.textContent = 'REL';
  const title = svg('title');
  title.textContent = 'Relative level: simulated receive level, or your key while sending';
  const needle = svg('line', { class: 'm-needle', x1: PIVOT.x, y1: PIVOT.y, x2: PIVOT.x, y2: PIVOT.y - NEEDLE });
  const hub = svg('circle', { class: 'm-hub', cx: PIVOT.x, cy: PIVOT.y, r: 2.6 });
  meter.append(title, mode, needle, hub);
  if (live) {
    needles.push(needle);
    modeLabels.push(mode);
  } else {
    needle.setAttribute('transform', `rotate(${angleFor(.22)} ${PIVOT.x} ${PIVOT.y})`);
  }
  return meter;
}

/** A meter and plate for the read-only rig preview; it does not follow the live receiver. */
export function previewStrip(call) {
  const strip = document.createElement('div');
  strip.className = 'strip';
  const plate = document.createElement('div');
  plate.className = 'plate';
  const text = document.createElement('span');
  text.textContent = call;
  plate.append(text);
  strip.append(plate, buildMeter(false));
  return strip;
}

function buildStrip(strip) {
  const plate = document.createElement('div');
  plate.className = 'plate';
  const text = document.createElement('span');
  text.textContent = document.body.dataset.user;
  plate.append(text);
  strip.replaceChildren(plate, buildMeter());
}

function frame(now) {
  const dt = Math.min(.05, (now - lastFrame) / 1000 || .016);
  lastFrame = now;
  const tx = isKeyDown();
  const target = tx ? KEYED_LEVEL : receiveLevel();
  velocity += (STIFFNESS * (target - value) - DAMPING * velocity) * dt;
  value = Math.min(1.05, Math.max(0, value + velocity * dt));

  const transform = `rotate(${angleFor(value).toFixed(2)} ${PIVOT.x} ${PIVOT.y})`;
  for (const needle of needles) needle.setAttribute('transform', transform);
  if (tx !== lastTx) {
    lastTx = tx;
    for (const label of modeLabels) label.textContent = tx ? 'TX' : 'REL';
  }
  requestAnimationFrame(frame);
}

export function initFaceplate() {
  for (const strip of document.querySelectorAll('[data-strip]')) buildStrip(strip);
  requestAnimationFrame(frame);
}
