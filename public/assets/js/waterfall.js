import { LEVEL } from './signal.js';

/*
 * The band recorder behind the waterfall.
 *
 * Every few milliseconds the receiver listens to the whole band (7.020-7.040 MHz)
 * and the result is kept as rows of intensities, newest first, indexed by absolute
 * frequency and time. The waterfall on screen is only a 2 kHz window moved over
 * this history, so tuning away and back finds the old traces where they were,
 * aged by the time spent away.
 *
 * Rows are on a dB scale like a panadapter: the noise floor sits low and steady,
 * a signal is as bright as it is far above the noise, so a QRP station near the
 * floor is a faint trace and a loud one is bright.
 */

export const SPAN_HZ = 2000;      // width of the visible window
export const BAND_MIN = -10000;   // band edges, as Hz from 7.030 MHz
export const BAND_MAX = 10000;

const BIN_HZ = 2.5;               // 10 Hz is a whole number of bins, so tuning never lands between columns
const BINS = (BAND_MAX - BAND_MIN) / BIN_HZ;
export const VIEW_BINS = SPAN_HZ / BIN_HZ;
export const ROWS = 150;
const ROW_MS = 25;                // one row per receiver tick; rows are added by elapsed time, so the scale does not depend on frame rate

const rows = Array.from({ length: ROWS }, () => new Uint8Array(BINS));
const held = new Float32Array(BINS);    // strongest keyed signal power since the last row, noise = 1
const frame = new Float32Array(BINS);
let newest = 0;                   // index in `rows` of the latest row
let stored = 0;                   // how many rows hold real history
let lastRowAt = null;
let added = 0;                    // rows written since the page loaded
let shown = 0;                    // value of `added` at the last render
let shownFirst = -1;              // first band bin of the last render
let repaintAll = true;
// Intensity (0..1, kept in the history) -> colour. The history stores intensity, not colour,
// so a new palette recolours everything already on screen.
const GQRX_STOPS = [[0, '#020722'], [.28, '#0a2a9a'], [.5, '#16b8e8'], [.72, '#ffe14a'], [1, '#ff7a1a']];
const CLASSIC_STOPS = [
  [0, '#010206'], [.1, '#030614'], [.22, '#060e30'], [.34, '#0e286e'],
  [.5, '#186ebe'], [.66, '#28bee1'], [.82, '#aaf0eb'], [1, '#fff8b4'],
];
const CUSTOM_AT = [0, .3, .62, 1];    // noise floor, weak, medium, strong
export const DISPLAY_PRESETS = ['gqrx', 'classic', 'custom'];
const HEX = /^#[0-9a-f]{6}$/;

export const defaultDisplay = () => ({
  preset: 'gqrx', colors: ['#020722', '#0a2a9a', '#16d0e8', '#ffb030'], trace: '#dff6ff',
});

/** Any display-shaped value as a clean one; anything unknown falls back to the defaults. */
export function cleanDisplay(input) {
  const display = defaultDisplay();
  if (!input || typeof input !== 'object') return display;
  if (DISPLAY_PRESETS.includes(input.preset)) display.preset = input.preset;
  if (Array.isArray(input.colors) && input.colors.length === 4 && input.colors.every(c => HEX.test(c))) display.colors = [...input.colors];
  if (HEX.test(input.trace)) display.trace = input.trace;
  return display;
}

export function displayStops(display) {
  if (display.preset === 'gqrx') return GQRX_STOPS;
  if (display.preset === 'classic') return CLASSIC_STOPS;
  return display.colors.map((color, i) => [CUSTOM_AT[i], color]);
}

export const gradientCss = display =>
  'linear-gradient(90deg, ' + displayStops(display).map(([at, color]) => `${color} ${Math.round(at * 100)}%`).join(', ') + ')';

export const palette = new Uint32Array(256);

/** Recolours the waterfall, history included. */
export function setPalette(display) {
  const stops = displayStops(display).map(([at, hex]) => [at, parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5), 16)]);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 1;
    while (k < stops.length - 1 && stops[k][0] < t) k++;
    const [t0, r0, g0, b0] = stops[k - 1], [t1, r1, g1, b1] = stops[k];
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    palette[i] = (255 << 24) | (Math.round(b0 + (b1 - b0) * f) << 16) | (Math.round(g0 + (g1 - g0) * f) << 8) | Math.round(r0 + (r1 - r0) * f);    // ImageData is little-endian RGBA
  }
  repaintAll = true;
}
setPalette(defaultDisplay());
const BACKGROUND = 0xff000000;    // empty, never recorded: pure black, darker than any noise row

// A keyed CW signal: a bright narrow core with softer skirts, as power.
const KERNEL_BINS = 100;
const kernel = Float32Array.from({ length: KERNEL_BINS + 1 }, (_, k) => {
  const hz = k * BIN_HZ;
  return ((.85 * Math.exp(-(hz * hz) / 72) + .2 * Math.exp(-(hz * hz) / 800)) / 1.05) ** 2;
});

const BIN_SNR_DB = 40;     // a 0 dB station stands this far above the noise in one bin
const FLOOR_DB = -8;       // bottom of the colour scale, relative to the mean noise
const RANGE_DB = 50;
const OWN_DB = 6;          // our own 100 W transmitter, seen on our own display

// Band noise: a gently uneven floor across frequency, and exponential grain so a few cells flash brighter.
const phases = [Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28];
const floorProfile = Float32Array.from({ length: BINS }, (_, b) =>
  1 + .12 * Math.sin(b / 270 + phases[0]) + .1 * Math.sin(b / 69 + phases[1]) + .06 * Math.sin(b / 15 + phases[2]));
const GRAIN = Float32Array.from({ length: 1024 }, (_, i) => Math.min(6, -Math.log(1 - (i + .5) / 1024)));

export function clear() {
  stored = 0;
  held.fill(0);
  lastRowAt = null;
  repaintAll = true;
}

export const binOf = offsetHz => Math.round((offsetHz - BAND_MIN) / BIN_HZ);

export const rowCount = () => added;

/** Copies the newest row of the visible window into `out` (VIEW_BINS values). False while nothing is recorded. */
export function latest(out, startOffset) {
  if (stored === 0) return false;
  const first = binOf(startOffset);
  const row = rows[newest];
  for (let x = 0; x < VIEW_BINS; x++) out[x] = row[first + x];
  return true;
}

function paint(target, centre, db, duty = 1) {
  const power = 10 ** ((db + BIN_SNR_DB) / 10) * duty;
  for (let k = -KERNEL_BINS; k <= KERNEL_BINS; k++) {
    const b = centre + k;
    if (b >= 0 && b < BINS) target[b] += power * kernel[Math.abs(k)];
  }
}

const levelOf = s => (s.db === undefined ? 20 * Math.log10(Math.max(1e-6, s.amp) / LEVEL) : s.db);

/**
 * Listens to the whole band. `signals` is [{ offset, db or amp, duty? }] keyed since the last
 * call; `duty` is the part of that time the key was down. Offsets are RF frequencies, so the
 * receiver's sidetone pitch never moves a trace. `noiseDb` lifts the whole floor (band noise,
 * static crashes). `own` is our transmitter, { offset, db, duty } relative to 100 W, or null.
 * Keying only adds that trace: the floor and scale never depend on it, so rows don't flash.
 * Rows are added for the time that has passed since the last one, however often this is called.
 */
export function record(signals, { rfGain, own = null, now, noiseDb = 0 }) {
  frame.fill(0);
  for (const s of signals) paint(frame, binOf(s.offset), levelOf(s), s.duty ?? 1);
  if (own && own.duty > 0) paint(frame, binOf(own.offset), OWN_DB + own.db, own.duty);
  for (let b = 0; b < BINS; b++) if (frame[b] > held[b]) held[b] = frame[b];

  if (lastRowAt === null || now - lastRowAt > 1000) lastRowAt = now - ROW_MS;    // first call, or the tab was suspended
  const due = Math.floor((now - lastRowAt) / ROW_MS);
  if (due < 1) return;
  lastRowAt += due * ROW_MS;

  // RF gain brightens noise and signals alike; the display saturates long before the audio does
  const shiftDb = Math.min(12, 20 * Math.log10(rfGain)) / 2;
  const drift = 1 + .07 * Math.sin(now / 6700) + .05 * Math.sin(now / 2300 + 1.3);
  const noise = 10 ** (noiseDb / 10);
  const offset = shiftDb - FLOOR_DB;
  for (let i = 0; i < due; i++) {
    newest = (newest + 1) % ROWS;
    const row = rows[newest];
    const level = noise * drift * (.93 + .14 * Math.random());
    for (let b = 0; b < BINS; b++) {
      const power = level * floorProfile[b] * GRAIN[(Math.random() * 1024) | 0] + held[b];
      const v = (10 * Math.log10(power) + offset) / RANGE_DB;
      row[b] = v >= 1 ? 255 : v <= 0 ? 0 : (v * 255) | 0;
    }
    stored = Math.min(ROWS, stored + 1);
    added++;
  }
  held.fill(0);
}

/**
 * Paints the window starting at `startOffset` into `pixels` (a Uint32Array of VIEW_BINS x ROWS).
 * The picture is kept between calls: new rows are written at the top and everything else moves
 * down, so each row is drawn once. Only a different window or a cleared history repaints it all.
 */
export function render(pixels, startOffset) {
  const first = binOf(startOffset);
  const fresh = Math.min(ROWS, added - shown);
  const repaint = repaintAll || first !== shownFirst || fresh >= ROWS;
  const top = repaint ? ROWS : fresh;
  if (!repaint && fresh > 0) pixels.copyWithin(fresh * VIEW_BINS, 0, (ROWS - fresh) * VIEW_BINS);

  for (let y = 0; y < top; y++) {
    const line = y * VIEW_BINS;
    if (y >= stored) {
      pixels.fill(BACKGROUND, line, line + VIEW_BINS);
      continue;
    }
    const row = rows[(newest - y + ROWS) % ROWS];
    for (let x = 0; x < VIEW_BINS; x++) pixels[line + x] = palette[row[first + x]];
  }
  shown = added;
  shownFirst = first;
  repaintAll = false;
}
