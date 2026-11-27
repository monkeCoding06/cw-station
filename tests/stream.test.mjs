import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamer, BATCH_MS, HEARTBEAT_MS, MAX_EVENTS } from '../public/assets/js/transmit.js';
import { StreamTimeline, TIMING } from '../public/assets/js/stream.js';

/* A small discrete-event clock standing in for performance.now() and setTimeout. */
function simClock() {
  let now = 0, nextId = 1;
  const tasks = new Map();
  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) { const id = nextId++; tasks.set(id, { at: now + Math.max(0, ms), fn }); return id; },
      clearTimeout(id) { tasks.delete(id); },
    },
    at(time, fn) { return this.timers.setTimeout(fn, time - now); },
    runUntil(end) {
      for (;;) {
        let next = null;
        for (const [id, task] of tasks) if (!next || task.at < next[1].at || (task.at === next[1].at && id < next[0])) next = [id, task];
        if (!next || next[1].at > end) break;
        tasks.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

/* The relay's acceptance rules, so the tests notice if the streamer would be cut off. */
function relayCheck() {
  let q = 0, n = 0, t = 0, state = 0;
  return packet => {
    if (packet.q === 1) q = n = t = state = 0;   // a new connection
    assert.equal(packet.q, q + 1, 'sequence');
    assert.ok(Number.isInteger(packet.n) && packet.n >= n, 'n runs forward');
    assert.ok(packet.e.length <= MAX_EVENTS, 'event count');
    for (const [et, s] of packet.e) {
      assert.ok(Number.isInteger(et) && et >= t && et <= packet.n, 'event time');
      assert.equal(s, 1 - state, 'alternates');
      state = s; t = et;
    }
    assert.equal(packet.k, state, 'k matches');
    q = packet.q; n = packet.n;
  };
}

function streamer(clock, extra = {}) {
  const sent = [];
  const check = relayCheck();
  const s = createStreamer({
    send: p => { check(p); sent.push({ ...JSON.parse(JSON.stringify(p)), sentAt: clock.now() }); },
    frequency: () => 120, now: clock.now, timers: clock.timers, ...extra,
  });
  return { s, sent };
}

/* Keys a pattern of [downMs, upMs] pairs from `from`, through the clock. Returns the local key times. */
function keyPattern(clock, s, from, pairs) {
  const edges = [];
  let t = from;
  for (const [down, up] of pairs) {
    const d = t, u = t + down;
    clock.at(d, () => s.key(true, d));
    clock.at(u, () => s.key(false, u));
    edges.push([d, 1], [u, 0]);
    t = u + up;
  }
  return edges;
}

const dits = (wpm, count) => Array.from({ length: count }, () => [1200 / wpm, 1200 / wpm]);

// ---------- streamer ----------

test('the first key-down goes out at once, with no duration', () => {
  const clock = simClock();
  const { s, sent } = streamer(clock);
  s.start(0);
  clock.runUntil(100);
  s.key(true, 100);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { t: 'key', q: 1, n: 100, k: 1, f: 120, p: 100, e: [[100, 1]], sentAt: 100 });
});

test('a power change applies from the next key-down, never inside a mark', () => {
  const clock = simClock();
  let watts = 100;
  const { s, sent } = streamer(clock, { power: () => watts });
  s.start(0);
  clock.at(10, () => s.key(true, 10));
  clock.at(60, () => { watts = 5; });            // turned down while the key is held
  clock.at(70, () => s.key(false, 70));
  clock.at(75, () => s.key(true, 75));            // same batch window as the key-up
  clock.at(80, () => s.key(false, 80));
  clock.runUntil(400);
  const marks = [];
  for (const packet of sent) for (const [t, on] of packet.e) if (on) marks.push([t, packet.p]);
  assert.deepEqual(marks, [[10, 100], [75, 5]]);
  // the key-up at 70 still went out at 100 W, before the 5 W key-down
  const upAt70 = sent.find(packet => packet.e.some(([t]) => t === 70));
  assert.equal(upAt70.p, 100);
  assert.ok(sent.filter(packet => packet.q > upAt70.q).every(packet => packet.p === 5));
});

test('transitions inside the batch window share a packet and wait at most BATCH_MS', () => {
  const clock = simClock();
  const { s, sent } = streamer(clock);
  s.start(0);
  clock.at(10, () => s.key(true, 10));
  clock.at(14, () => s.key(false, 14));
  clock.at(18, () => s.key(true, 18));
  clock.runUntil(40);
  assert.deepEqual(sent.map(p => [p.sentAt, p.e]), [[10, [[10, 1]]], [10 + BATCH_MS, [[14, 0], [18, 1]]]]);
});

test('continuous dits stream while the paddle is still held', () => {
  for (const wpm of [5, 20, 40]) {
    const clock = simClock();
    const { s, sent } = streamer(clock);
    s.start(0);
    const edges = keyPattern(clock, s, 50, dits(wpm, Math.round(30000 / (2400 / wpm))));
    const lastEdge = edges[edges.length - 1][0];
    clock.runUntil(lastEdge - 1);   // the paddle has not been let go yet
    const delivered = sent.flatMap(p => p.e.map(([t]) => ({ t, sentAt: p.sentAt })));
    assert.ok(delivered.length >= edges.length - 2, `${wpm} WPM: ${delivered.length} of ${edges.length}`);
    for (const { t, sentAt } of delivered) assert.ok(sentAt - t <= BATCH_MS, `${wpm} WPM sent ${sentAt - t} ms after keying`);
    clock.runUntil(lastEdge + 1000);
    assert.deepEqual(sent.flatMap(p => p.e), edges.map(([t, st]) => [Math.round(t), st]));
  }
});

test('a held key sends heartbeats, and one more after the key-up', () => {
  const clock = simClock();
  const { s, sent } = streamer(clock);
  s.start(0);
  clock.at(0, () => s.key(true, 0));
  clock.at(20000, () => s.key(false, 20000));
  clock.runUntil(25000);
  const beats = sent.filter(p => p.e.length === 0);
  assert.equal(beats.filter(p => p.k === 1).length, Math.floor(20000 / HEARTBEAT_MS) - 1);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].sentAt - sent[i - 1].sentAt <= HEARTBEAT_MS);
  const last = sent[sent.length - 1];
  assert.deepEqual([last.k, last.e, last.sentAt], [0, [], 20000 + HEARTBEAT_MS]);
});

test('more than MAX_EVENTS transitions in one window are split, in order', () => {
  const clock = simClock();
  const { s, sent } = streamer(clock);
  s.start(0);
  s.key(true, 0);
  clock.runUntil(1);
  for (let i = 0; i < 149; i++) s.key(i % 2 === 1, 1);
  clock.runUntil(100);
  assert.ok(sent.every(p => p.e.length <= MAX_EVENTS));
  assert.equal(sent.flatMap(p => p.e).length, 150);
});

test('no key-down while switched off, and its key-up is not sent either', () => {
  const clock = simClock();
  let on = false;
  const { s, sent } = streamer(clock, { canSend: () => on });
  s.start(0);
  s.key(true, 0);
  on = true;
  s.key(false, 50);
  clock.runUntil(500);
  assert.equal(sent.length, 0);
  clock.runUntil(600);
  s.key(true, 600);
  clock.runUntil(700);
  s.release(700);
  clock.runUntil(2000);
  assert.deepEqual(sent.flatMap(p => p.e), [[600, 1], [700, 0]]);
});

test('keying times never run ahead of now or backwards', () => {
  const clock = simClock();
  const { s, sent } = streamer(clock);
  s.start(0);
  clock.runUntil(100);
  s.key(true, 150);
  s.key(false, 90);
  clock.runUntil(500);
  assert.deepEqual(sent.flatMap(p => p.e), [[100, 1], [100, 0]]);
});

test('a new stream restarts numbering, and a key already held is sent at once', () => {
  const clock = simClock();
  const { s, sent } = streamer(clock);
  s.start(0);
  s.key(true, 0);
  s.stop();
  clock.runUntil(1000);
  assert.equal(sent.length, 1);
  sent.length = 0;
  s.start(1000);
  assert.deepEqual(sent.map(p => [p.q, p.e]), [[1, [[0, 1]]]]);
  s.stop();
  s.key(false, 1100);
  s.start(1200);
  clock.runUntil(3000);
  assert.equal(sent.length, 1);
});

// ---------- receiver timeline ----------

/* Applies the timeline's output the way playback.js drives the audio. */
function schedule() {
  let list = [];
  return {
    apply({ cancelFrom, add }) {
      if (cancelFrom !== null) list = list.filter(x => x.at < cancelFrom);
      list.push(...add);
    },
    get list() { return list; },
  };
}

/*
 * Sender -> network -> receiver, all simulated. `network(t)` gives the one-way
 * delay of a packet sent at t; delivery stays in order, as on a WebSocket.
 * The receiver's clock is offset and may drift, so nothing relies on shared clocks.
 */
function run({ pattern, network = () => 20, latency = 0, fixedDelay = null, skew = 987654.321, drift = 0, end, lose = () => false }) {
  const clock = simClock();
  const timeline = new StreamTimeline({ fixedDelay });
  const out = schedule();
  const receiverTime = t => t * (1 + drift) + skew;
  let lastArrival = 0;
  const { s, sent } = streamer(clock);
  const realSend = sent.push.bind(sent);
  sent.push = packet => {
    realSend(packet);
    if (lose(packet)) return;
    const arrival = Math.max(lastArrival, clock.now() + network(clock.now()));
    lastArrival = arrival;
    clock.at(arrival, () => out.apply(timeline.receive(packet, receiverTime(arrival), latency)));
  };
  s.start(0);
  const edges = keyPattern(clock, s, 100, pattern);
  for (let t = 0; t < end; t += 25) clock.at(t, () => {
    const now = receiverTime(t);
    out.apply(timeline.watchdog(now));
    timeline.sample(now - 20);
  });
  clock.runUntil(end);
  const played = out.list.map(x => ({ ...x, local: (x.at - skew) / (1 + drift) }));
  return { edges, played, timeline };
}

const delays = ({ edges, played }) => edges.map(([t], i) => played[i].local - t);
const stats = list => {
  const sorted = [...list].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[sorted.length >> 1], p95: sorted[Math.floor(sorted.length * .95)], max: sorted[sorted.length - 1] };
};
const fmt = ({ min, median, p95, max }) => `min ${min.toFixed(1)} / median ${median.toFixed(1)} / p95 ${p95.toFixed(1)} / max ${max.toFixed(1)} ms`;

test('an initial key-down plays at once, before its length is known', () => {
  const timeline = new StreamTimeline();
  const { add } = timeline.receive({ q: 1, n: 0, k: 1, f: 50, e: [[0, 1]] }, 5000);
  assert.equal(add.length, 1);
  assert.equal(add[0].on, 1);
  assert.equal(add[0].f, 50);
  assert.ok(add[0].at >= 5000 + TIMING.lead && add[0].at <= 5000 + TIMING.minDelay + TIMING.lead);
});

test('transitions carry the power of their key-down; older senders count as 100 W', () => {
  const timeline = new StreamTimeline();
  const first = timeline.receive({ q: 1, n: 0, k: 0, f: 0, e: [[0, 1], [50, 0]] }, 5000).add;
  assert.deepEqual(first.map(x => x.p), [100, 100]);
  const second = timeline.receive({ q: 2, n: 200, k: 0, f: 0, p: 1, e: [[100, 1], [150, 0]] }, 5200).add;
  assert.deepEqual(second.map(x => x.p), [1, 1]);
  const third = timeline.receive({ q: 3, n: 300, k: 1, f: 0, p: 7, e: [[300, 1]] }, 5300).add;
  assert.deepEqual(third.map(x => x.p), [100]);
});

test('steady network: every mark and space keeps its keyed length, delay is constant', () => {
  const pattern = [[60, 60], [180, 60], [60, 180], [180, 420], [73, 51], [211, 67]];
  const result = run({ pattern, end: 5000 });
  assert.equal(result.played.length, result.edges.length);
  const d = delays(result);
  for (const value of d) assert.ok(Math.abs(value - d[0]) < 1e-6, `delay moved: ${d}`);
});

test('30 s of dits under jitter: delay bounded and not growing, marks exact', () => {
  for (const wpm of [5, 20, 40]) {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const unit = 1200 / wpm;
    const result = run({ pattern: dits(wpm, Math.round(30000 / (2 * unit))), network: () => 20 + random() * 40, end: 32000 });
    assert.equal(result.played.length, result.edges.length);
    const d = delays(result);
    const st = stats(d);
    console.log(`  ${wpm} WPM dits, 20-60 ms network jitter, 30 s: playback delay ${fmt(st)}`);
    assert.ok(st.max < 20 + 40 + TIMING.maxDelay, 'bounded');
    const early = stats(d.slice(0, d.length / 3)), late = stats(d.slice(-d.length / 3));
    assert.ok(late.median <= early.median + 20, `grew from ${early.median} to ${late.median}`);
    // the first mark arrives before any jitter has been seen and may run a little long
    for (let i = 0; i < result.played.length; i += 2) {
      const keyed = result.edges[i + 1][0] - result.edges[i][0];
      const heard = result.played[i + 1].local - result.played[i].local;
      assert.ok(Math.abs(heard - keyed) <= (i === 0 ? 40 : 1), `mark ${i / 2}: ${keyed} heard as ${heard}`);
    }
  }
});

test('a straight-key hold of 20 s plays before release and ends at the right time', () => {
  const result = run({ pattern: [[20000, 100]], end: 22000 });
  assert.equal(result.played.length, 2);
  const [down, up] = result.played;
  assert.ok(down.local < 100 + 200, 'tone starts while still held');
  assert.ok(Math.abs((up.local - down.local) - 20000) <= 1);
});

test('a stall followed by a burst resyncs instead of keeping the extra delay', () => {
  const pattern = dits(20, 200);
  const result = run({ pattern, network: t => (t > 3000 && t < 5000 ? 5000 - t + 20 : 20), end: 25000 });
  const d = [];
  for (const x of result.played) {
    const keyed = result.edges.filter(([t, on]) => t <= x.local && on === x.on).pop();
    if (keyed) d.push([keyed[0], x.local - keyed[0]]);
  }
  const after = d.filter(([t]) => t > 9000).map(([, v]) => v);
  const st = stats(after);
  console.log(`  2 s stall then burst: delay once recovered ${fmt(st)}`);
  assert.ok(st.max < 400, 'back to a small delay');
  assert.ok(result.timeline.idleAt(1e12));
});

test('±100 ppm clock drift over two minutes stays bounded', () => {
  for (const drift of [100e-6, -100e-6]) {
    const result = run({ pattern: dits(20, 1000), drift, end: 122000 });
    const d = delays(result);
    const st = stats(d);
    console.log(`  drift ${drift > 0 ? '+' : '-'}100 ppm, 120 s: delay ${fmt(st)}`);
    assert.ok(st.max - st.min < 60, 'delay stays put');
  }
});

test('the latency setting is added once, not per word', () => {
  const words = Array.from({ length: 40 }, (_, i) => (i % 5 === 4 ? [180, 420] : [60, 60]));
  const plain = stats(delays(run({ pattern: words, end: 10000 })));
  const delayed = stats(delays(run({ pattern: words, latency: 500, end: 10000 })));
  assert.ok(Math.abs(delayed.median - plain.median - 500) < 2);
  assert.ok(delayed.max - delayed.min < 2);
});

test('Echo plays a second behind, and starts long before a long transmission ends', () => {
  const result = run({ pattern: dits(20, 100), network: () => 0, fixedDelay: 1000, end: 15000 });
  const d = delays(result);
  for (const value of d) assert.ok(Math.abs(value - 1000) < 1);
  assert.ok(result.played[0].local < result.edges[result.edges.length - 1][0]);
});

test('a lost key-up is repaired by the next packet', () => {
  const result = run({ pattern: [[60, 300], [60, 300]], end: 3000, lose: p => p.q === 2 });
  const states = result.played.map(x => x.on);
  assert.deepEqual(states, [1, 0, 1, 0]);
  const stuck = result.played[1].local - result.played[0].local;
  assert.ok(stuck < HEARTBEAT_MS + 100, `tone held ${stuck} ms`);
});

test('a sender that goes silent while keyed is keyed up by the watchdog', () => {
  const timeline = new StreamTimeline();
  const out = schedule();
  out.apply(timeline.receive({ q: 1, n: 0, k: 1, f: 0, e: [[0, 1]] }, 1000));
  out.apply(timeline.watchdog(1000 + TIMING.watchdog - 1));
  assert.equal(out.list.length, 1);
  out.apply(timeline.watchdog(1000 + TIMING.watchdog + 1));
  assert.deepEqual(out.list.map(x => x.on), [1, 0]);
  out.apply(timeline.watchdog(5000));
  assert.equal(out.list.length, 2);
  assert.ok(timeline.idleAt(1e9));
});

test('old or repeated packets are ignored', () => {
  const timeline = new StreamTimeline();
  timeline.receive({ q: 1, n: 0, k: 1, f: 0, e: [[0, 1]] }, 0);
  assert.deepEqual(timeline.receive({ q: 1, n: 0, k: 1, f: 0, e: [[0, 1]] }, 10), { cancelFrom: null, add: [] });
});

test('the receiver queue stays bounded under a flood', () => {
  const timeline = new StreamTimeline();
  let q = 0, n = 0, state = 0;
  for (let i = 0; i < 5000; i++) {
    const e = [];
    for (let j = 0; j < 64; j++) { state = 1 - state; e.push([n, state]); }
    timeline.receive({ q: ++q, n, k: state, f: 0, e }, n + 50);
    n += 1;
    assert.ok(timeline.queued.length <= TIMING.maxQueued + 64);
  }
});

test('end to end on a healthy link: delay from keying to scheduled playback', () => {
  let seed = 3;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pattern = [];
  for (let i = 0; i < 400; i++) pattern.push([60 * (random() < .3 ? 3 : 1) + random() * 8, 60 * (random() < .2 ? 3 : 1) + random() * 8]);
  const result = run({ pattern, network: () => 25 + random() * 10, end: 100000 });
  const st = stats(delays(result));
  console.log(`  end to end, 25-35 ms one-way network, 20 WPM hand keying: ${fmt(st)} (plus the device's audio output latency)`);
  assert.ok(st.median < 150 && st.max < 200);
});
