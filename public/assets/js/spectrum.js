import { VIEW_BINS, latest, palette, rowCount } from './waterfall.js';

/*
 * The live spectrum above the waterfall. It reads the same band bins the waterfall
 * records, newest row only, so a peak sits exactly over its waterfall trace.
 * Behind the bright trace, a short history of where the level has been builds up
 * as a coloured band, painted with the waterfall palette.
 */

const HEIGHT = 96;
const DECAY = .94;        // per row, about .4 s of memory at 40 rows a second
const HEAT_SCALE = .12;
const TOP_MARGIN = 6;
const EMPTY = 0xff050805;

const heat = new Float32Array(VIEW_BINS * HEIGHT);
const trace = new Float32Array(VIEW_BINS);
const row = new Uint8Array(VIEW_BINS);
let canvas, ctx, picture, pixels;
let seenRows = -1, seenStart = null, live = false;
let traceColor = '#dff6ff';

export function initSpectrum(element) {
  canvas = element;
  canvas.width = VIEW_BINS;
  canvas.height = HEIGHT;
  ctx = canvas.getContext('2d');
  picture = ctx.createImageData(VIEW_BINS, HEIGHT);
  pixels = new Uint32Array(picture.data.buffer);
}

export function setTraceColor(color) {
  traceColor = color;
}

export function clearSpectrum() {
  heat.fill(0);
  trace.fill(0);
  seenRows = -1;
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

const levelY = v => HEIGHT - 1 - Math.round(Math.min(1, v / 255) * (HEIGHT - 1 - TOP_MARGIN));

function advance(startOffset) {
  const rows = rowCount();
  live = latest(row, startOffset);
  if (!live || startOffset !== seenStart) {
    heat.fill(0);
    trace.fill(0);
    seenRows = -1;
  }
  seenStart = startOffset;
  if (!live) {
    seenRows = rows;
    return;
  }
  if (rows !== seenRows) {
    for (let i = 0; i < heat.length; i++) heat[i] *= DECAY;
    for (let x = 0; x < VIEW_BINS; x++) {
      const y = levelY(row[x]);
      heat[y * VIEW_BINS + x] += 1;
      if (y > 0) heat[(y - 1) * VIEW_BINS + x] += .4;
      if (y < HEIGHT - 1) heat[(y + 1) * VIEW_BINS + x] += .4;
      trace[x] = row[x] > trace[x] ? row[x] : trace[x] * .5 + row[x] * .5;    // peaks jump up and fall back over a few rows
    }
  }
  seenRows = rows;
}

/** Draws the spectrum for the window at `startOffset`. `shade` marks the passband on top. */
export function drawSpectrum(startOffset, shade) {
  advance(startOffset);
  for (let i = 0; i < heat.length; i++) {
    const h = heat[i];
    pixels[i] = h < .05 ? EMPTY : palette[Math.min(255, (h * HEAT_SCALE * 230) | 0)];
  }
  ctx.putImageData(picture, 0, 0);

  ctx.fillStyle = 'rgba(255, 255, 255, .07)';
  for (let i = 1; i < 4; i++) ctx.fillRect(Math.round(i * VIEW_BINS / 4), 0, 1, HEIGHT);
  for (let i = 1; i < 4; i++) ctx.fillRect(0, Math.round(i * HEIGHT / 4), VIEW_BINS, 1);

  if (live) {
    ctx.beginPath();
    ctx.moveTo(0, HEIGHT);
    for (let x = 0; x < VIEW_BINS; x++) ctx.lineTo(x + .5, levelY(trace[x]) + .5);
    ctx.lineTo(VIEW_BINS, HEIGHT);
    ctx.globalAlpha = .12;
    ctx.fillStyle = traceColor;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (let x = 0; x < VIEW_BINS; x++) ctx.lineTo(x + .5, levelY(trace[x]) + .5);
    ctx.strokeStyle = traceColor;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
  shade(ctx, canvas);
}
