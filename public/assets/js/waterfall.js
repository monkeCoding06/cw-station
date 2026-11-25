/*
 * The band recorder behind the waterfall.
 *
 * Every few milliseconds the receiver listens to the whole band (7.020-7.040 MHz)
 * and the result is kept as rows of intensities, newest first, indexed by absolute
 * frequency and time. The waterfall on screen is only a 2 kHz window moved over
 * this history, so tuning away and back finds the old traces where they were,
 * aged by the time spent away.
 */

export const SPAN_HZ = 2000;      // width of the visible window
export const BAND_MIN = -10000;   // band edges, as Hz from 7.030 MHz
export const BAND_MAX = 10000;

const BIN_HZ = 2.5;               // 10 Hz is a whole number of bins, so tuning never lands between columns
const BINS = (BAND_MAX - BAND_MIN) / BIN_HZ;
export const VIEW_BINS = SPAN_HZ / BIN_HZ;
export const ROWS = 150;
const ROW_MS = 50;                // one stored row covers this long; short dits are peak-held into it

const rows = Array.from({ length: ROWS }, () => new Uint8Array(BINS));
const pending = new Float32Array(BINS);
const scratch = new Float32Array(BINS);
let newest = 0;                   // index in `rows` of the latest row
let stored = 0;                   // how many rows hold real history
let lastRowAt = 0;

const palette = new Uint32Array(256).map((_, i) => {
  // Noise floor stays near black, so keyed signals stand out as bright traces.
  const a = Math.min(1, Math.max(0, (i / 255 - .2) / .5));
  const red = 4 + 251 * a ** 1.6, green = 8 + 247 * Math.sqrt(a), blue = 6 + 150 * a ** 2.5;
  return (255 << 24) | (blue << 16) | (green << 8) | red;     // ImageData is little-endian RGBA
});
const BACKGROUND = palette[0];

export function clear() {
  stored = 0;
  pending.fill(0);
}

const binOf = offsetHz => Math.round((offsetHz - BAND_MIN) / BIN_HZ);

/**
 * Listens to the whole band once. `signals` is [{ offset, amp }] keyed right now.
 * While we transmit we hear nothing, and our own tone shows at `ownOffset`.
 */
export function record(signals, { rfGain, listening, ownOffset, now }) {
  for (let b = 0; b < BINS; b++) scratch[b] = .04 + .15 * Math.random() * Math.random();

  if (listening) {
    for (const s of signals) {
      const centre = binOf(s.offset);
      for (let b = Math.max(0, centre - 40); b <= Math.min(BINS - 1, centre + 40); b++) {
        const away = (b - centre) * BIN_HZ;
        scratch[b] += s.amp * Math.exp(-(away * away) / 125);
      }
    }
    const gain = Math.sqrt(Math.min(rfGain, 4));    // the display saturates long before the audio does
    for (let b = 0; b < BINS; b++) scratch[b] *= gain;
  }

  if (ownOffset !== null) {
    const centre = binOf(ownOffset);
    for (let b = Math.max(0, centre - 40); b <= Math.min(BINS - 1, centre + 40); b++) {
      const away = (b - centre) * BIN_HZ;
      scratch[b] += Math.exp(-(away * away) / 80);
    }
  }

  for (let b = 0; b < BINS; b++) if (scratch[b] > pending[b]) pending[b] = scratch[b];

  if (now - lastRowAt >= ROW_MS) {
    lastRowAt = now;
    newest = (newest + 1) % ROWS;
    const row = rows[newest];
    for (let b = 0; b < BINS; b++) row[b] = Math.min(255, pending[b] * 255);
    pending.fill(0);
    stored = Math.min(ROWS, stored + 1);
  }
}

/** Paints the window starting at `startOffset` into `pixels` (a Uint32Array of VIEW_BINS x ROWS). */
export function render(pixels, startOffset) {
  const first = binOf(startOffset);
  for (let y = 0; y < ROWS; y++) {
    const line = y * VIEW_BINS;
    if (y >= stored) {
      pixels.fill(BACKGROUND, line, line + VIEW_BINS);
      continue;
    }
    const row = rows[(newest - y + ROWS) % ROWS];
    for (let x = 0; x < VIEW_BINS; x++) pixels[line + x] = palette[row[first + x]];
  }
}
