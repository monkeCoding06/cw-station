/*
 * Streams what the operator keys, transition by transition, while it happens.
 * Nothing waits for a letter, a word or the paddle to be released: the first
 * transition goes out at once, later ones within BATCH_MS, and while the key
 * is held a heartbeat tells receivers the sender is still there.
 *
 * A packet is { t: 'key', q, n, k, f, e }:
 *   q - sequence number, 1, 2, 3 ... per connection
 *   n - when it was sent, in ms since the stream started (the sender's clock only)
 *   k - key state at n: 1 down, 0 up
 *   f - transmit frequency, as Hz offset from 7.030 MHz
 *   p - transmit power in watts, as set at the latest key-down
 *   e - transitions since the previous packet: [[t, state], ...], t in stream ms
 */

export const BATCH_MS = 15;
export const HEARTBEAT_MS = 250;
export const MAX_EVENTS = 64;

/** Returns { key, start, stop, release }. `send(packet)` gets each packet; nothing is sent before start(). */
export function createStreamer({ send, frequency, power = () => 100, canSend = () => true, now = () => performance.now(), timers = globalThis }) {
  let origin = null;        // performance.now() at stream start, null while there is no stream
  let seq = 0;
  let held = false;
  let watts = power();      // only picked up at a key-down, so a mark never changes power halfway
  let pending = [];
  let lastFlush = -Infinity;
  let lastT = 0;            // stream times must never run backwards or ahead of the packet
  let flushTimer = null;
  let beatTimer = null;

  const streamMs = at => Math.max(0, Math.round(at - origin));

  function flush() {
    timers.clearTimeout(flushTimer);
    flushTimer = null;
    if (origin === null) return;
    let k, carried;
    do {
      const e = pending.splice(0, MAX_EVENTS);
      k = e.length ? e[e.length - 1][1] : held ? 1 : 0;
      carried = e.length > 0;
      lastFlush = now();
      send({ t: 'key', q: ++seq, n: streamMs(lastFlush), k, f: frequency(), p: watts, e });
    } while (pending.length);

    // held: keep beating; just released: one more beat, so a lost key-up is repaired soon
    timers.clearTimeout(beatTimer);
    beatTimer = k === 1 || carried ? timers.setTimeout(flush, HEARTBEAT_MS) : null;
  }

  function key(on, at = now()) {
    if (on === held || (on && !canSend())) return;
    held = on;
    if (on && power() !== watts) {
      if (origin !== null && pending.length) flush();   // marks already keyed keep the power they had
      watts = power();
    }
    if (origin === null) return;
    lastT = Math.max(lastT, Math.min(streamMs(at), streamMs(now())));
    pending.push([lastT, on ? 1 : 0]);
    if (flushTimer !== null) return;
    const wait = lastFlush + BATCH_MS - now();
    if (wait <= 0) flush();
    else flushTimer = timers.setTimeout(flush, wait);
  }

  return {
    key,

    /** A new connection: a new stream. A key already held goes out at once. */
    start(at = now()) {
      stop();
      origin = at;
      if (held) {
        pending.push([0, 1]);
        flush();
      }
    },

    stop,

    /** Lets go of the key, e.g. when the receiver is switched off mid-mark. */
    release(at = now()) {
      key(false, at);
    },
  };

  function stop() {
    timers.clearTimeout(flushTimer);
    timers.clearTimeout(beatTimer);
    flushTimer = beatTimer = null;
    origin = null;
    seq = 0;
    pending = [];
    lastFlush = -Infinity;
    lastT = 0;
  }
}
