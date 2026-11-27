/*
 * Receiver timeline for one remote key stream. No audio or DOM here: packets
 * go in, key transitions on the local performance.now() clock come out.
 *
 * Sender times (t, n) are ms since the sender's stream started, on the
 * sender's clock; only their differences mean anything here. A transition at
 * sender time t plays at t + offset. The offset is picked so that a packet's
 * newest data plays about `target` ms after it arrives: the jitter seen
 * recently plus a margin, plus the user's latency setting. It only moves at a
 * key-down, so every mark keeps its keyed length and the gap before it takes
 * up the change.
 */

import { cleanWatts, DEFAULT_WATTS } from './signal.js';

export const TIMING = {
  minDelay: 40,         // jitter buffer bounds in ms, before the user's latency
  maxDelay: 300,
  margin: 25,           // headroom above the jitter seen
  jitterDecay: .002,    // ms of jitter estimate forgotten per ms
  baseWindow: 10000,    // ms of arrivals used for the clock baseline
  lead: 5,              // nothing is scheduled closer to now than this
  lateTolerance: 150,   // a packet whose data is already this late is skipped...
  staleResync: 1000,    // ...unless that goes on for this much sender time
  maxExcess: 250,       // playing further behind than target + this: resync
  shrink: .15,          // share of a gap that may go to catching up
  idleReset: 1500,      // after a gap this long the offset snaps to target
  watchdog: 1000,       // key held but no packet for this long: key up
  maxQueued: 1024,
};

export class StreamTimeline {
  constructor({ fixedDelay = null, timing = TIMING } = {}) {
    this.fixedDelay = fixedDelay;   // Echo: a set delay instead of a jitter buffer
    this.timing = timing;
    this.offset = null;
    this.q = 0;
    this.state = 0;                 // key state at the end of what is scheduled
    this.schedEnd = -Infinity;      // local time of the last scheduled transition
    this.lastUpT = null;            // sender time of the last key-up
    this.jitter = 0;
    this.arrivals = [];             // [arrival, arrival - n]
    this.lastArrival = null;
    this.staleSince = null;
    this.watts = DEFAULT_WATTS;     // transmit power of the last key-down scheduled
    this.queued = [];               // future transitions { at, on, f, p }
    this.current = { at: -Infinity, on: 0, f: 0, p: DEFAULT_WATTS };   // the latest one already reached
  }

  /** Feeds one packet. Returns { cancelFrom, add } for the audio: drop what is scheduled from cancelFrom on, then add these. */
  receive(packet, arrival, latency = 0) {
    const T = this.timing;
    const out = { cancelFrom: null, add: [] };
    if (packet.q <= this.q) return out;
    this.q = packet.q;
    const p = cleanWatts(packet.p);   // older senders leave it out

    const off = arrival - packet.n;
    if (this.lastArrival !== null) this.jitter = Math.max(0, this.jitter - T.jitterDecay * (arrival - this.lastArrival));
    this.lastArrival = arrival;

    const ahead = this.offset === null ? 0 : this.offset - off;   // how far after its arrival this packet's "now" plays
    if (ahead < -T.lateTolerance) {
      this.staleSince ??= packet.n;
      if (packet.n - this.staleSince < T.staleResync) return out;
      this.arrivals = [];           // the path got slower for good: measure afresh
    }
    this.staleSince = null;

    this.arrivals.push([arrival, off]);
    while (this.arrivals.length > 1 && (this.arrivals[0][0] < arrival - T.baseWindow || this.arrivals.length > T.maxQueued)) this.arrivals.shift();
    let base = Infinity;
    for (const [, value] of this.arrivals) base = Math.min(base, value);
    this.jitter = Math.max(this.jitter, Math.min(off - base, T.maxDelay));

    const buffer = this.fixedDelay ?? Math.min(T.maxDelay, Math.max(T.minDelay, this.jitter + T.margin));
    const target = buffer + latency;
    const desired = base + target;

    if (this.offset === null) {
      this.offset = desired;
    } else if (this.offset - off > target + T.maxExcess || ahead < -T.lateTolerance || this.queued.length > T.maxQueued) {
      this.resync(arrival, desired, out);
    }

    for (const [t, s] of packet.e) {
      if (s === this.state) continue;     // a packet in between was lost
      let at;
      if (s === 1) {
        const gap = this.lastUpT === null ? Infinity : t - this.lastUpT;
        if (gap >= T.idleReset || desired > this.offset) this.offset = desired;
        else this.offset = Math.max(desired, this.offset - T.shrink * gap);
        at = t + this.offset;
        const earliest = Math.max(arrival + T.lead, this.schedEnd);
        if (at < earliest) {
          this.offset += earliest - at;
          at = earliest;
        }
      } else {
        at = Math.max(t + this.offset, arrival + T.lead, this.schedEnd);
        this.lastUpT = t;
      }
      this.push(at, s, packet.f, p, out);
    }

    // the packet's own key state wins; this is how a lost key-up is repaired
    if (packet.k !== this.state) {
      if (packet.k === 0) this.lastUpT = packet.n;
      this.push(Math.max(packet.n + this.offset, arrival + T.lead, this.schedEnd), packet.k, packet.f, p, out);
    }
    return out;
  }

  resync(arrival, desired, out) {
    const kept = this.queued.filter(x => x.at <= arrival);
    this.queued = kept;
    const last = kept.length ? kept[kept.length - 1] : this.current;
    this.state = last.on;
    this.watts = last.p;
    this.schedEnd = arrival;
    this.offset = desired;
    this.lastUpT = null;
    out.cancelFrom = arrival;
  }

  push(at, on, f, p, out) {
    if (on) this.watts = p;
    const transition = { at, on, f, p: this.watts };
    this.queued.push(transition);
    out.add.push(transition);
    this.state = on;
    this.schedEnd = at;
  }

  /** Keys up a stream that went quiet while held, or whose sender left. */
  keyUp(now) {
    const out = { cancelFrom: null, add: [] };
    if (this.state === 1) this.push(Math.max(now + this.timing.lead, this.schedEnd), 0, this.current.f, this.watts, out);
    return out;
  }

  watchdog(now) {
    const silent = this.lastArrival !== null && now - this.lastArrival > this.timing.watchdog;
    return silent ? this.keyUp(now) : { cancelFrom: null, add: [] };
  }

  /** The transition in effect at `time`, without moving on. */
  at(time) {
    let found = this.current;
    for (const transition of this.queued) {
      if (transition.at > time) break;
      found = transition;
    }
    return found;
  }

  /** The transition in effect at `now`; earlier ones are dropped. */
  sample(now) {
    while (this.queued.length && this.queued[0].at <= now) this.current = this.queued.shift();
    return this.current;
  }

  idleAt(now) {
    return this.state === 0 && this.schedEnd <= now;
  }
}
