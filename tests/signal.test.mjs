import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanWatts, dbToAmp, displayLevel, fadeDb, LEVEL, MAX_PATH_LOSS, pathBetween, POWER_LEVELS, powerDb, SCAN_MIN_DB, steadyDb,
} from '../public/assets/js/signal.js';
import * as waterfall from '../public/assets/js/waterfall.js';

const close = (actual, expected, within, label) =>
  assert.ok(Math.abs(actual - expected) <= within, `${label}: ${actual.toFixed(2)}, expected ${expected} ±${within}`);

test('same path: 5 W is ~13 dB and 1 W 20 dB below 100 W', () => {
  const path = pathBetween('OE1AAA', 'DL2BBB');
  close(steadyDb(100, path) - steadyDb(5, path), 13, .1, '100 W - 5 W');
  close(steadyDb(100, path) - steadyDb(1, path), 20, 1e-9, '100 W - 1 W');
  close(steadyDb(100, path) - steadyDb(0.5, path), 23, .1, '100 W - 0.5 W');
  assert.equal(powerDb(100), 0);
  assert.equal(dbToAmp(0), LEVEL);   // 100 W over a clean path sounds as before
});

test('unsupported or missing power is treated as 100 W', () => {
  for (const bad of [undefined, null, NaN, 3, 1000, '5', true]) assert.equal(cleanWatts(bad), 100, String(bad));
  for (const ok of POWER_LEVELS) assert.equal(cleanWatts(ok), ok);
});

test('a path is fixed per pair and band, the same both ways, and never depends on power', () => {
  const ab = pathBetween('oe1aaa', 'DL2BBB');
  assert.deepEqual(ab, pathBetween('DL2BBB', 'OE1AAA'));
  assert.deepEqual(ab, pathBetween('OE1AAA', 'DL2BBB'));
  assert.notDeepEqual(ab, pathBetween('OE1AAA', 'DL2BBB', '20m'));
  const t = 1.7e12;
  for (const w of POWER_LEVELS) close(steadyDb(w, ab) + fadeDb(ab, t) - (powerDb(w) + ab.baseDb + fadeDb(ab, t)), 0, 1e-12, `${w} W`);

  // spread over many pairs: most paths good, all within the loss range
  const losses = Array.from({ length: 2000 }, (_, i) => -pathBetween('OE1AAA', `K${i}XYZ`).baseDb);
  assert.ok(Math.min(...losses) >= 0 && Math.max(...losses) <= MAX_PATH_LOSS);
  assert.ok(losses.filter(l => l < 6).length > losses.length * .4, 'about half the paths are good');
  assert.ok(losses.some(l => l > 18), 'some paths are marginal');
});

test('fading stays within its depth and moves slowly', () => {
  const path = pathBetween('OE1AAA', 'W1AW');
  let worstStep = 0;
  for (let t = 0; t < 600000; t += 100) {
    const db = fadeDb(path, 1.7e12 + t);
    assert.ok(Math.abs(db) <= path.depthDb + 1e-9);
    worstStep = Math.max(worstStep, Math.abs(db - fadeDb(path, 1.7e12 + t - 100)));
  }
  assert.ok(worstStep < .1, `at most a fraction of a dB per 100 ms, got ${worstStep}`);
});

// Audio SNR, simulated with the same filters as rig.js: noise ±.38 -> bandpass(pitch, Q .8) -> bandpass(pitch, Q pitch/bw).
function bandpass(f0, q, rate) {
  const w = 2 * Math.PI * f0 / rate, alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return x => {
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

function noiseRms(pitch, bw) {
  let seed = 12345;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rate = 48000, first = bandpass(pitch, .8, rate), second = bandpass(pitch, pitch / bw, rate);
  let sum = 0, count = 0;
  for (let i = 0; i < rate * 4; i++) {
    const y = second(first((random() * 2 - 1) * .38));
    if (i > rate / 2) { sum += y * y; count++; }
  }
  return Math.sqrt(sum / count);
}

test('simulated audio SNR at 500 Hz bandwidth: 1 W copyable on a good path, gone on a marginal one', () => {
  const noise = noiseRms(600, 500);
  const snr = db => 20 * Math.log10(dbToAmp(db) / Math.SQRT2 / noise);
  const good = pathBetween('A', 'B'), worst = { ...good, baseDb: -MAX_PATH_LOSS };
  good.baseDb = 0;
  const table = {
    '100 W good': snr(steadyDb(100, good)), '5 W good': snr(steadyDb(5, good)), '1 W good': snr(steadyDb(1, good)),
    '100 W marginal': snr(steadyDb(100, worst)), '1 W marginal': snr(steadyDb(1, worst)),
  };
  console.log('SNR dB (tone RMS / noise RMS in the passband):', Object.entries(table).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', '));
  assert.ok(table['1 W good'] >= 3, '1 W on a good path stands clear of the noise');
  assert.ok(table['100 W marginal'] >= 0, '100 W on the worst path is still readable');
  assert.ok(table['1 W marginal'] <= -10, '1 W on the worst path is lost in the noise');
  // fading on the worst path never brings 1 W back up to readable
  assert.ok(snr(steadyDb(1, worst) + 6) <= -10);
});

test('waterfall: trace brightness follows power, background noise does not', () => {
  const at = 500, start = at - 1000;
  const row = new Float32Array(waterfall.VIEW_BINS);
  const runs = {};
  for (const watts of [100, 5, 1]) {
    waterfall.clear();
    const peaks = [], floor = [];
    for (let i = 0; i < 400; i++) {
      waterfall.record([{ offset: at, db: powerDb(watts) }], { rfGain: 1, listening: true, ownOffset: null, now: 1e6 + i * 40 });
      waterfall.latest(row, start);
      peaks.push(row[1000 / waterfall.SPAN_HZ * waterfall.VIEW_BINS | 0]);
      floor.push(...row.slice(0, 100));
    }
    const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
    runs[watts] = { peak: mean(peaks), floor: mean(floor) };
  }
  assert.ok(runs[100].peak > runs[5].peak && runs[5].peak > runs[1].peak, JSON.stringify(runs));
  assert.ok(runs[1].peak > runs[1].floor * 2, '1 W on a clean path still shows');
  close(runs[1].floor, runs[100].floor, runs[100].floor * .05, 'noise floor');
  // amp-only signals (Training) still paint as before
  assert.equal(displayLevel(0), LEVEL);
});

test('scan threshold sits between a 1 W good path and a 1 W marginal path', () => {
  const good = { baseDb: 0, depthDb: 2 }, worst = { baseDb: -MAX_PATH_LOSS, depthDb: 6 };
  assert.ok(steadyDb(1, good) - good.depthDb >= SCAN_MIN_DB);
  assert.ok(steadyDb(1, worst) + worst.depthDb < SCAN_MIN_DB);
  assert.ok(steadyDb(100, worst) + worst.depthDb >= SCAN_MIN_DB);
});
