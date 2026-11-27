import { $ } from './util.js';
import { audioContext, audioTimeAt, outputLatencyMs, receiveLatencyMs } from './audio.js';
import { filterGain, receiverInput, tuneOffset } from './rig.js';
import { StreamTimeline } from './stream.js';
import { dbToAmp, fadeDb, FLAT_PATH, steadyDb } from './signal.js';

/*
 * Plays remote key streams on the receiver. Each stream has one oscillator for
 * its whole life, keyed by gain automation, so a held key is just a held
 * gain. Audio, waterfall, signal meter and scan all read the same timeline,
 * and the same received level: power and path set the keyed gain at each
 * key-down, fading moves the level gain slowly underneath.
 */

const RAMP = .002;            // time constant of the key envelope, s
const MAX_STREAMS = 32;
const ACTIVE_FOR_MS = 1200;   // a station counts as mid-transmission this long after a key-up
const FORGET_AFTER_MS = 30000;

const toneHz = f => Math.max(25, +$('pitch').value + f - tuneOffset());

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
    level.gain.value = filterGain(f - tuneOffset()) * 10 ** (fadeDb(path, Date.now()) / 20);
    tone.connect(envelope).connect(level).connect(input);
    tone.start();
    return { timeline: new StreamTimeline({ fixedDelay }), path, tone, envelope, level, f, ended: false };
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
        const fade = fadeDb(stream.path, wall);
        stream.tone.frequency.setTargetAtTime(toneHz(f), t, .004);
        stream.level.gain.setTargetAtTime(filterGain(f - tuneOffset()) * 10 ** (fade / 20), t, .004);
        const current = stream.timeline.sample(heardAt);
        const db = steadyDb(current.p, stream.path) + fade;
        if (current.on) signals.push({ offset: current.f, amp: dbToAmp(db), db });
        if (current.on || stream.timeline.queued.length || heardAt - current.at < ACTIVE_FOR_MS) active.push({ offset: current.f, db });

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
