import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandDb, bandNoiseDb, birdieFor, cleanWatts, dbToAmp, fadeDb, FLAT_PATH, LEVEL, localNoiseDb, MAX_PATH_LOSS, noiseRms,
  pathBetween, pathDb, POWER_LEVELS, powerDb, READABLE_SNR, snrDb, steadyDb,
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
  for (const w of POWER_LEVELS) close(steadyDb(w, ab) + pathDb(ab, t) - (powerDb(w) + ab.baseDb + pathDb(ab, t)), 0, 1e-12, `${w} W`);

  // spread over many pairs: most paths good, some marginal, a few bad even for 100 W
  const losses = Array.from({ length: 2000 }, (_, i) => -pathBetween('OE1AAA', `K${i}XYZ`).baseDb);
  assert.ok(Math.min(...losses) >= 0 && Math.max(...losses) <= MAX_PATH_LOSS);
  assert.ok(losses.filter(l => l < 6).length > losses.length * .35, 'plenty of good paths');
  assert.ok(losses.filter(l => l > 18).length > losses.length * .2, 'some paths are marginal');
  assert.ok(losses.some(l => l > 32), 'a few are bad');
});

test('fading: bounded, smooth, continuous through gaps, and with short QSB that lifts a weak signal', () => {
  const path = { ...pathBetween('OE1AAA', 'W1AW'), baseDb: -18, depthDb: 3.5, qsbDb: 4 };
  let worstStep = 0, lo = Infinity, hi = -Infinity;
  for (let t = 0; t < 600000; t += 100) {
    const db = fadeDb(path, 1.7e12 + t);
    assert.ok(Math.abs(db) <= path.depthDb + path.qsbDb + 1e-9);
    worstStep = Math.max(worstStep, Math.abs(db - fadeDb(path, 1.7e12 + t - 100)));
    if (t < 20000) { lo = Math.min(lo, db); hi = Math.max(hi, db); }
  }
  assert.ok(worstStep < 1.5, `under 1.5 dB per 100 ms, got ${worstStep.toFixed(2)}`);
  assert.ok(hi - lo > 4, `QSB swings several dB within 20 s, got ${(hi - lo).toFixed(1)}`);
  // nothing in here depends on keying, so a word gap does not reset it
  close(fadeDb(path, 1.7e12 + 700) - fadeDb(path, 1.7e12 + 699), 0, .02, 'continuous');
});

test('band conditions and noise drift slowly, the same for everybody; local noise is per receiver', () => {
  let maxBand = 0, maxNoise = 0, step = 0;
  for (let t = 0; t < 3.6e6; t += 1000) {
    maxBand = Math.max(maxBand, Math.abs(bandDb(1.7e12 + t)));
    maxNoise = Math.max(maxNoise, Math.abs(bandNoiseDb(1.7e12 + t)));
    step = Math.max(step, Math.abs(bandDb(1.7e12 + t) - bandDb(1.7e12 + t - 1000)));
  }
  assert.ok(maxBand <= 3 && maxBand > 1.5 && maxNoise <= 2 && step < .05, `${maxBand} ${maxNoise} ${step}`);
  const a = pathBetween('A1A', 'B1B'), b = pathBetween('C1C', 'D1D'), t = 1.7e12;
  close(pathDb(a, t) - fadeDb(a, t), pathDb(b, t) - fadeDb(b, t), 1e-9, 'band part shared');
  assert.equal(pathDb(FLAT_PATH, t), 0, 'Echo stays clean');
  assert.equal(localNoiseDb('oe1aaa'), localNoiseDb('OE1AAA'));
  assert.notEqual(localNoiseDb('OE1AAA'), localNoiseDb('OE1BBB'));
  const birdie = birdieFor('OE1AAA');
  assert.ok(Math.abs(birdie.offset) >= 2000 && Math.abs(birdie.offset) <= 9500 && birdie.db < -28);
});

// rig.js filters noise through two equal bandpass sections, Q = .6436 * pitch / bw, from white noise ±.3366
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

function simulatedNoise(pitch, bw) {
  let seed = 12345;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rate = 48000, first = bandpass(pitch, .6436 * pitch / bw, rate), second = bandpass(pitch, .6436 * pitch / bw, rate);
  let sum = 0, count = 0;
  for (let i = 0; i < rate * 4; i++) {
    const y = second(first((random() * 2 - 1) * .3366));
    if (i > rate / 2) { sum += y * y; count++; }
  }
  return Math.sqrt(sum / count);
}

test('audio noise follows the bandwidth at any pitch, as the model says', () => {
  for (const pitch of [350, 600, 950]) {
    for (const bw of [200, 500, 900]) {
      const got = simulatedNoise(pitch, bw);
      close(20 * Math.log10(got / noiseRms(bw)), 0, .3, `${pitch} Hz pitch, ${bw} Hz`);
    }
  }
  close(snrDb(0, 200) - snrDb(0, 500), 10 * Math.log10(2.5), .01, 'narrowing 500 -> 200 Hz');
});

test('SNR: QRP works a good path, struggles on a marginal one; 100 W can still have a bad path', () => {
  const at = (watts, loss, bw = 500) => snrDb(powerDb(watts) - loss, bw);
  const table = {
    '0.5 W good': at(.5, 0), '0.5 W marginal': at(.5, 18), '100 W marginal': at(100, 18),
    '100 W bad': at(100, MAX_PATH_LOSS), '100 W bad 200 Hz': at(100, MAX_PATH_LOSS, 200),
  };
  console.log('SNR dB in the passband:', Object.entries(table).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', '));
  assert.ok(table['0.5 W good'] >= READABLE_SNR + 3);
  assert.ok(table['0.5 W marginal'] <= -12, '0.5 W on a marginal path is down in the noise');
  assert.ok(table['0.5 W marginal'] + 8 < READABLE_SNR, 'even a good fade leaves it hard to copy');
  assert.ok(table['100 W marginal'] >= 5);
  assert.ok(table['100 W bad'] < READABLE_SNR, '100 W on a bad path is hard going');
  assert.ok(table['100 W bad 200 Hz'] > table['100 W bad'] + 3, 'a narrow filter helps');
});

const row = new Float32Array(waterfall.VIEW_BINS);
const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
const centre = waterfall.VIEW_BINS / 2;

test('waterfall: dB scale, trace follows power, background does not, faint signals sit near the floor', () => {
  const runs = {};
  for (const [name, db] of [['100 W', 0], ['5 W', powerDb(5)], ['0.5 W', powerDb(.5)], ['0.5 W marginal', powerDb(.5) - 18]]) {
    waterfall.clear();
    const peaks = [], floor = [];
    for (let i = 0; i < 400; i++) {
      waterfall.record([{ offset: 0, db }], { rfGain: 1, now: 1e6 + i * 25 });
      waterfall.latest(row, -1000);
      peaks.push(row[centre]);
      floor.push(...row.slice(0, 100));
    }
    runs[name] = { peak: mean(peaks), floor: mean(floor) };
  }
  console.log('waterfall peak / floor:', Object.entries(runs).map(([k, v]) => `${k} ${v.peak.toFixed(0)}/${v.floor.toFixed(0)}`).join(', '));
  assert.ok(runs['100 W'].peak > runs['5 W'].peak && runs['5 W'].peak > runs['0.5 W'].peak);
  assert.ok(runs['0.5 W'].peak > runs['0.5 W'].floor * 2, '0.5 W on a clean path still shows');
  assert.ok(runs['0.5 W marginal'].peak < runs['0.5 W'].floor * 2, 'marginal QRP is barely above the floor');
  close(runs['0.5 W'].floor, runs['100 W'].floor, runs['100 W'].floor * .05, 'noise floor');
  close((runs['100 W'].peak - runs['5 W'].peak) / 255 * 50, 13, 1.5, '13 dB on the colour scale');
});

test('waterfall: a held mark is continuous, keying shows marks and spaces, retuning keeps history', () => {
  waterfall.clear();
  const column = [];
  for (let i = 0; i < 40; i++) {
    const on = i < 20 || i % 4 < 2;        // a held mark, then dits two rows on, two rows off
    waterfall.record(on ? [{ offset: 300, db: -6, duty: 1 }] : [], { rfGain: 1, now: 2e6 + i * 25 });
    waterfall.latest(row, -1000);
    column.push(row[centre + 300 / 2.5]);
  }
  assert.ok(column.slice(1, 20).every(v => v > 150), 'held mark: every row bright');
  const keyed = column.slice(20);
  assert.ok(keyed.filter(v => v > 150).length === 10 && keyed.filter(v => v < 90).length === 10, `marks and spaces ${keyed}`);
  // move the window 600 Hz: the same trace is still there, at its own frequency
  waterfall.latest(row, -400);
  assert.ok(row[waterfall.VIEW_BINS / 2 - 400 / 2.5 + 300 / 2.5 + 240] < 255);
  const before = new Float32Array(waterfall.VIEW_BINS);
  waterfall.latest(before, -1000);
  waterfall.latest(row, -400);
  assert.equal(row[(300 - -400) / 2.5], before[(300 - -1000) / 2.5]);
});

test('waterfall: a short element still marks its row by its duty', () => {
  waterfall.clear();
  waterfall.record([{ offset: 0, db: 0, duty: .4 }], { rfGain: 1, now: 3e6 });
  waterfall.latest(row, -1000);
  assert.ok(row[centre] > 200, `10 ms of a 25 ms row: ${row[centre]}`);
  assert.equal(LEVEL, dbToAmp(0));
});

test('waterfall: local keying adds a narrow trace and never moves the background', () => {
  // RF gain up and some band noise, as on the air; idle, dits, then a held key at -200 Hz
  const opts = (i, own) => ({ rfGain: 4, noiseDb: 2, now: 4e6 + i * 25, own });
  const neighbour = { offset: 400, db: -10, duty: 1 };
  const tx = power => ({ offset: -200, db: powerDb(power), duty: 1 });
  const rows = { idle: [], dits: [], held: [] };
  waterfall.clear();
  for (let i = 0; i < 360; i++) {
    const phase = i < 120 ? 'idle' : i < 240 ? 'dits' : 'held';
    const own = phase === 'held' || (phase === 'dits' && i % 4 < 2) ? tx(100) : null;
    waterfall.record([neighbour], opts(i, own));
    waterfall.latest(row, -1000);
    rows[phase].push({ on: !!own, floor: mean([...row.slice(0, 80), ...row.slice(560, 720)]), tx: row[centre - 80], far: row[centre - 80 + 40], other: row[centre + 160] });
  }
  const floor = list => mean(list.map(r => r.floor));
  close(floor(rows.dits.filter(r => r.on)), floor(rows.idle), 1.5, 'background on key-down vs idle');
  close(floor(rows.dits.filter(r => !r.on)), floor(rows.idle), 1.5, 'background on key-up vs idle');
  close(floor(rows.held), floor(rows.idle), 1.5, 'background during a held key');
  assert.ok(rows.held.every(r => r.tx > 200), 'held key: continuous trace');
  assert.ok(rows.dits.every(r => (r.on ? r.tx > 200 : r.tx < floor(rows.idle) + 45)), 'dits: marks and spaces');
  assert.ok(mean(rows.held.map(r => r.far)) < floor(rows.idle) + 10, 'trace is narrow: 100 Hz off is background');
  close(mean(rows.held.map(r => r.other)), mean(rows.idle.map(r => r.other)), 3, 'other station keeps its level');

  const level = power => {
    waterfall.clear();
    waterfall.record([], opts(0, tx(power)));
    waterfall.latest(row, -1000);
    return row[centre - 80];
  };
  assert.ok(level(.5) < level(100) - 50 && level(.5) > 150, `0.5 W own trace is dimmer but clear: ${level(.5)} vs ${level(100)}`);
});
