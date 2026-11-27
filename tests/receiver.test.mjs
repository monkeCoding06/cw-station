import { test } from 'node:test';
import assert from 'node:assert/strict';

// Just enough DOM and Web Audio to run the real playback.js, rig.js and waterfall.js in Node.
const fields = { pitch: '600', vfo: '0', bw: '500 Hz', rf: '0', latency: '0', vol: '35', speed: '20', pwr: '100 W' };
globalThis.document = {
  addEventListener() {},
  dispatchEvent() {},
  body: { classList: { toggle() {} }, dataset: {} },
  getElementById: id => ({ get value() { return fields[id] ?? ''; }, set value(v) { fields[id] = v; }, setAttribute() {}, dispatchEvent() {} }),
};

class Param {
  constructor(value = 0) { this.value = value; this.targets = []; }
  setTargetAtTime(value, at) { this.targets.push([at, value]); }
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime() {}
  cancelScheduledValues() {}
}
const node = extra => ({ connect: next => next, disconnect() {}, ...extra });
globalThis.AudioContext = class {
  currentTime = 1;
  state = 'running';
  destination = node();
  sampleRate = 8000;
  createOscillator() { return node({ frequency: new Param(), start() {}, stop() {} }); }
  createGain() { return node({ gain: new Param(1) }); }
  createBiquadFilter() { return node({ frequency: new Param(), Q: new Param() }); }
  createDynamicsCompressor() { return node({ threshold: new Param(), knee: new Param(), ratio: new Param() }); }
  createBuffer(_, length) { return { getChannelData: () => new Float32Array(length) }; }
  createBufferSource() { return node({ start() {} }); }
};

const { createReceiver } = await import('../public/assets/js/playback.js');
const waterfall = await import('../public/assets/js/waterfall.js');
const { pathBetween, FLAT_PATH, powerDb, birdieFor } = await import('../public/assets/js/signal.js');
const rig = await import('../public/assets/js/rig.js');

/* What the relay broadcasts for a one-second key-down at `p` watts, as parsed from the WebSocket. */
const relayed = (q, n, p) => [
  { t: 'key', sid: 7, call: 'OE1PHN', q, n, k: 1, f: 0, p, e: [[n, 1]] },
  { t: 'key', sid: 7, call: 'OE1PHN', q: q + 1, n: n + 1000, k: 0, f: 0, p, e: [[n + 1000, 0]] },
];

/* Plays the same keyed second at 100 W, then at 0.5 W, over one fixed path; returns what the receiver did. */
function compare(path) {
  const receiver = createReceiver({ pathTo: () => path });
  const result = {};
  let q = 1, sentAt = 0, now = performance.now();
  for (const watts of [100, 0.5]) {
    const [down, up] = relayed(q, sentAt, watts);
    receiver.handle(7, down, now);
    receiver.handle(7, up, now + 1000);
    // envelope gain targets scheduled for this mark: the tone's keyed level
    const envelope = envelopes[envelopes.length - 2];   // open() makes the envelope, then the level gain
    const keyedGain = Math.max(...envelope.targets.slice(-2).map(([, v]) => v));
    // half-way through the mark, as heard: the level the meter, scan and waterfall use
    const { signals } = receiver.tick(now + 600);
    waterfall.clear();
    const row = new Float32Array(waterfall.VIEW_BINS);
    let trace = 0;
    for (let i = 0; i < 200; i++) {
      waterfall.record(signals, { rfGain: 1, now: 1e7 + i * 40 });
      waterfall.latest(row, -1000);
      trace += row[waterfall.VIEW_BINS / 2];
    }
    result[watts] = { keyedGain, db: signals[0].db, trace: trace / 200 };
    q += 2; sentAt += 3000; now += 3000;
  }
  receiver.clear();
  return result;
}

// playback.js keeps its streams private, so note every gain and oscillator it creates
const envelopes = [];
const oscillators = [];
const realCreateOscillator = AudioContext.prototype.createOscillator;
AudioContext.prototype.createOscillator = function () {
  const osc = realCreateOscillator.call(this);
  oscillators.push(osc);
  return osc;
};
const realCreateGain = AudioContext.prototype.createGain;
AudioContext.prototype.createGain = function () {
  const gain = realCreateGain.call(this);
  envelopes.push(gain.gain);
  return gain;
};

test('relayed 0.5 W arrives 23 dB below 100 W: weaker tone, dimmer waterfall, same path', () => {
  const clean = { baseDb: 0, depthDb: 0, periods: [1, 1], phases: [0, 0] };
  const marginal = { ...clean, baseDb: -24 };
  for (const [name, path] of [['good', clean], ['marginal', marginal], ['real pair', pathBetween('OE1PHN', 'OE1PC')]]) {
    const r = compare(path);
    const drop = r[100].db - r[0.5].db;
    console.log(`${name} path: 100 W ${r[100].db.toFixed(1)} dB, 0.5 W ${r[0.5].db.toFixed(1)} dB (drop ${drop.toFixed(2)} dB); ` +
      `tone gain ${r[100].keyedGain.toFixed(3)} -> ${r[0.5].keyedGain.toFixed(4)}; waterfall trace ${r[100].trace.toFixed(2)} -> ${r[0.5].trace.toFixed(2)}`);
    assert.ok(Math.abs(drop - 23.01) < .3, `${name}: drop ${drop}`);
    assert.ok(Math.abs(20 * Math.log10(r[100].keyedGain / r[0.5].keyedGain) - 23.01) < .05, `${name}: tone gain`);
    assert.ok(r[0.5].trace < r[100].trace, `${name}: waterfall`);
  }
});

test('a relayed packet without p plays at 100 W', () => {
  const receiver = createReceiver({ pathTo: () => ({ baseDb: 0, depthDb: 0, periods: [1, 1], phases: [0, 0] }) });
  const now = performance.now();
  const [down] = relayed(1, 0, 100);
  delete down.p;
  receiver.handle(9, down, now);
  const { signals } = receiver.tick(now + 300);
  assert.equal(signals[0].db, 0);
  receiver.clear();
});

const lastTarget = param => param.targets[param.targets.length - 1][1];
const keyDown = (sid, f, n = 0, p = 100) => ({ t: 'key', sid, call: 'OE1' + sid, q: 1, n, k: 1, f, p, e: [[n, 1]] });

test('two callers 300 Hz apart: both heard wide, the neighbour drops away narrow, but stays on the waterfall', () => {
  const receiver = createReceiver({ pathTo: () => FLAT_PATH });
  const now = performance.now();
  const first = envelopes.length;
  receiver.handle(1, keyDown(1, 0), now);
  receiver.handle(2, keyDown(2, 300), now);
  const [, levelA, , levelB] = envelopes.slice(first);    // envelope, level for each stream
  const levels = {};
  for (const bw of ['900 Hz', '500 Hz', '200 Hz']) {
    fields.bw = bw;
    const { signals } = receiver.tick(now + 400);
    levels[bw] = 20 * Math.log10(lastTarget(levelB) / lastTarget(levelA));
    if (bw === '200 Hz') {
      waterfall.clear();
      waterfall.record(signals, { rfGain: 1, now: 5e6 });
      const row = new Float32Array(waterfall.VIEW_BINS);
      waterfall.latest(row, -1000);
      assert.ok(row[(300 + 1000) / 2.5] > 200, 'neighbour still bright on the waterfall');
    }
  }
  console.log('neighbour 300 Hz up, relative to the wanted station:', Object.entries(levels).map(([k, v]) => `${k} ${v.toFixed(1)} dB`).join(', '));
  assert.ok(levels['900 Hz'] > -1, 'wide: both about equal');
  assert.ok(levels['500 Hz'] < -5 && levels['500 Hz'] > -10);
  assert.ok(levels['200 Hz'] < -35, 'narrow: neighbour gone');
  fields.bw = '500 Hz';
  receiver.clear();
});

test('beat pitch moves with the dial and folds over as the image below zero beat', () => {
  const receiver = createReceiver({ pathTo: () => FLAT_PATH });
  const now = performance.now();
  const before = oscillators.length;
  receiver.handle(3, keyDown(3, 0), now);
  const tone = oscillators[before];
  const pitches = [];
  for (const vfo of ['0', '-200', '200', '700']) {
    fields.vfo = vfo;
    receiver.tick(now + 300);
    pitches.push(lastTarget(tone.frequency));
  }
  assert.deepEqual(pitches, [600, 800, 400, 100]);
  fields.vfo = '0';
  assert.ok(rig.passband(-700) < .05 * rig.passband(0) || rig.passband(-700) < 1e-3, 'image rejected');
  receiver.clear();
});

test('short marks reach the waterfall as a duty fraction of the tick', () => {
  const receiver = createReceiver({ pathTo: () => FLAT_PATH });
  const now = performance.now();
  receiver.tick(now);
  receiver.handle(4, { t: 'key', sid: 4, call: 'OE1D', q: 1, n: 0, k: 0, f: 0, p: 100, e: [[0, 1], [10, 0]] }, now);
  let found = null;
  for (let t = now; t < now + 600 && !found; t += 25) found = receiver.tick(t).signals[0];
  assert.ok(found && found.duty > 0 && found.duty <= .45, JSON.stringify(found));
  receiver.clear();
});

test('S-meter reads the passband; scan only stops on readable stations keyed for a moment; band life is General only', () => {
  let seen = [];
  rig.listeners.active = list => { seen = list; };
  rig.setPower(true);
  rig.setBandActivity(null);
  const read = (signals, active = []) => { rig.update(signals, active); return rig.receiveLevel(); };

  fields.bw = '500 Hz';
  const noise500 = read([]);
  fields.bw = '200 Hz';
  const noise200 = read([]);
  const strong = read([{ offset: 0, db: 0 }]);
  const outside = read([{ offset: 1500, db: 0 }]);
  console.log(`meter: noise 500 Hz ${noise500.toFixed(3)}, 200 Hz ${noise200.toFixed(3)}, strong in passband ${strong.toFixed(3)}, strong 1.5 kHz off ${outside.toFixed(3)}`);
  assert.ok(noise200 < noise500, 'narrower filter, less noise on the meter');
  assert.ok(strong > noise500 + .4);
  assert.ok(outside - noise200 < .01, 'a station outside the passband hardly moves the needle');
  fields.bw = '500 Hz';

  read([], [
    { offset: 100, db: powerDb(.5), keyedMs: 300 },          // QRP on a good path: readable
    { offset: 200, db: powerDb(.5) - 18, keyedMs: 300 },     // QRP on a marginal path: audible at best
    { offset: 300, db: 0, keyedMs: 20 },                     // a blip
  ]);
  assert.deepEqual(seen.map(s => s.offset), [100]);

  const birdie = birdieFor('OE1AAA');
  rig.setBandActivity('OE1AAA');
  read([], [{ offset: 100, db: 0, keyedMs: 300 }]);
  assert.deepEqual(seen.map(s => s.offset), [100], 'the local carrier is never a station for scan');
  const row = new Float32Array(waterfall.VIEW_BINS);
  waterfall.clear();
  for (let i = 0; i < 4; i++) read([]);
  waterfall.latest(row, birdie.offset - 1000);
  const general = row[waterfall.VIEW_BINS / 2];
  rig.setBandActivity(null);
  waterfall.clear();
  for (let i = 0; i < 4; i++) read([]);
  waterfall.latest(row, birdie.offset - 1000);
  assert.ok(general > row[waterfall.VIEW_BINS / 2] + 20, `carrier shows in General only: ${general} vs ${row[waterfall.VIEW_BINS / 2]}`);
  rig.setPower(false);
});
