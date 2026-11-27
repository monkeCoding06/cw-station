import { test } from 'node:test';
import assert from 'node:assert/strict';

// Just enough DOM and Web Audio to run the real playback.js, rig.js and waterfall.js in Node.
const fields = { pitch: '600', vfo: '0', bw: '500 Hz', rf: '0', latency: '0', vol: '35', speed: '20', pwr: '100 W' };
globalThis.document = {
  addEventListener() {},
  getElementById: id => ({ get value() { return fields[id] ?? ''; }, set value(v) { fields[id] = v; } }),
};

class Param {
  constructor(value = 0) { this.value = value; this.targets = []; }
  setTargetAtTime(value, at) { this.targets.push([at, value]); }
  setValueAtTime(value) { this.value = value; }
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
const { pathBetween } = await import('../public/assets/js/signal.js');

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
      waterfall.record(signals, { rfGain: 1, listening: true, ownOffset: null, now: 1e7 + i * 40 });
      waterfall.latest(row, -1000);
      trace += row[waterfall.VIEW_BINS / 2];
    }
    result[watts] = { keyedGain, db: signals[0].db, trace: trace / 200 };
    q += 2; sentAt += 3000; now += 3000;
  }
  receiver.clear();
  return result;
}

// playback.js keeps its streams private, so note every gain it creates
const envelopes = [];
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
