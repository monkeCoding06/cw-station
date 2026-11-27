import { $ } from './util.js';
import { audioContext, audioTimeAt, outputLatencyMs, receiveLatencyMs } from './audio.js';
import { passband, receiverInput, tuneOffset } from './rig.js';
import { StreamTimeline } from './stream.js';
import { dbToAmp, FLAT_PATH, pathDb, steadyDb } from './signal.js';

/*
 * Plays remote key streams on the receiver. Each stream has one oscillator for
 * its whole life, keyed by gain automation, so a held key is just a held
 * gain. Audio, waterfall, signal meter and scan all read the same timeline,
 * and the same received level: power and path set the keyed gain at each
 * key-down; fading, band conditions and the receive filter move the level
 * gain smoothly underneath, also in the middle of a held mark.
 */

const RAMP = .002;            // time constant of the key envelope, s
const MAX_STREAMS = 32;
const ACTIVE_FOR_MS = 1200;   // a station counts as mid-transmission this long after a key-up
const FORGET_AFTER_MS = 30000;
const LEVEL_TC = .03;         // s; fades and tuning glide instead of stepping

// A station above the dial beats higher; one below zero beat folds back as the (rejected) image.
const toneHz = f => Math.max(20, Math.abs(+$('pitch').value + f - tuneOffset()));

/** `pathTo(call)` gives the path from a station to us; without it every station arrives over a clean path. */
export function createReceiver({ fixedDelay = null, pathTo = null } = {}) {
  const streams = new Map();   // id -> { timeline, path, tone, envelope, level, f, ended }

  function open(f, call) {
    const input = receiverInput();
    const audio = audioContext();
    const tone = audio.createOscillator();
    const envelope = audio.createGain();
    const level = audio.createGain();
    tone.frequency.value = toneHz(f);
    envelope.gain.value = 0;
    const path = pathTo && call ? pathTo(call) : FLAT_PATH;
    level.gain.value = passband(f) * 10 ** (pathDb(path, Date.now()) / 20);
    tone.connect(envelope).connect(level).connect(input);
    tone.start();
    return { timeline: new StreamTimeline({ fixedDelay }), path, tone, envelope, level, f, ended: false, heardAt: null, keyedMs: 0 };
  }

  function close(stream) {
    const t = audioContext().currentTime;
    stream.envelope.gain.cancelScheduledValues(t);
    stream.envelope.gain.setTargetAtTime(0, t, RAMP);
    stream.tone.onended = () => stream.level.disconnect();
    stream.tone.stop(t + .03);
  }

  function apply(stream, { cancelFrom, add }) {
    const gain = stream.envelope.gain;
    if (cancelFrom !== null) {
      const t = audioTimeAt(cancelFrom);
      gain.cancelScheduledValues(t);
      stream.tone.frequency.cancelScheduledValues(t);
      gain.setTargetAtTime(stream.timeline.state ? keyed(stream, stream.timeline.watts) : 0, t, RAMP);
    }
    for (const { at, on, f, p } of add) {
      const t = audioTimeAt(at);
      if (on && f !== stream.f) {
        stream.f = f;
        stream.tone.frequency.setValueAtTime(toneHz(f), t);
      }
      gain.setTargetAtTime(on ? keyed(stream, p) : 0, t, RAMP);
    }
  }

  const keyed = (stream, watts) => dbToAmp(steadyDb(watts, stream.path));

  /** How long the key was down between the previous tick and `until`, as heard. */
  function keyedSince(stream, until) {
    const from = stream.heardAt ?? until;
    let on = stream.timeline.current.on, at = from, ms = 0;
    for (const x of stream.timeline.queued) {
      if (x.at > until) break;
      if (x.at > at) {
        if (on) ms += x.at - at;
        at = x.at;
      }
      on = x.on;
    }
    return on ? ms + until - at : ms;
  }

  return {
    /** A key packet for stream `id`, received at performance.now() `arrival`. */
    handle(id, packet, arrival) {
      let stream = streams.get(id);
      if (!stream) {
        if (streams.size >= MAX_STREAMS) return;
        stream = open(packet.f, packet.call);
        streams.set(id, stream);
      }
      apply(stream, stream.timeline.receive(packet, arrival, receiveLatencyMs()));
    },

    /** The sender is gone: let what is scheduled finish, and make sure the key ends up. */
    end(id, now) {
      const stream = streams.get(id);
      if (!stream) return;
      stream.ended = true;
      apply(stream, stream.timeline.keyUp(now));
    },

    clear() {
      for (const stream of streams.values()) close(stream);
      streams.clear();
    },

    /** Called every tick: retunes the tones, runs the watchdog and reports what is on the air. */
    tick(now) {
      const signals = [];
      const active = [];
      if (!streams.size) return { signals, active };
      const t = audioContext().currentTime;
      const heardAt = now - outputLatencyMs();
      const wall = Date.now();
      for (const [id, stream] of streams) {
        apply(stream, stream.timeline.watchdog(now));
        const { f } = stream.timeline.at(now);
        const fade = pathDb(stream.path, wall);
        stream.tone.frequency.setTargetAtTime(toneHz(f), t, .012);
        stream.level.gain.setTargetAtTime(passband(f) * 10 ** (fade / 20), t, LEVEL_TC);
        const keyedMs = keyedSince(stream, heardAt);
        const current = stream.timeline.sample(heardAt);
        const db = steadyDb(current.p, stream.path) + fade;
        const span = heardAt - (stream.heardAt ?? heardAt);
        stream.heardAt = heardAt;
        // `duty` is the part of the last tick the key was down, so short elements still mark the waterfall
        const duty = span > 0 ? keyedMs / span : current.on;
        if (duty > 0) signals.push({ offset: current.f, amp: dbToAmp(db), db, duty, on: current.on });
        if (current.on || stream.timeline.queued.length || heardAt - current.at < ACTIVE_FOR_MS) {
          stream.keyedMs += keyedMs;
          active.push({ offset: current.f, db, keyedMs: stream.keyedMs });
        } else {
          stream.keyedMs = 0;
        }

        const forgotten = now - stream.timeline.lastArrival > FORGET_AFTER_MS;
        if ((stream.ended || forgotten) && stream.timeline.idleAt(now - 200)) {
          close(stream);
          streams.delete(id);
        }
      }
      return { signals, active };
    },
  };
}
