import { $ } from './util.js';

/* Audio engine: sidetone, master volume, and playback of keyed tones. */

let audio, sidetone, sidetoneGate, masterLevel;
const voices = new Set();      // tones started by playRuns, so they can all be silenced

export const unitMs = () => 1200 / Number($('speed').value);
export const receiveLatencyMs = () => Number($('latency').value);
export const audioContext = () => audio;
export const masterOutput = () => masterLevel;

export function enableAudio() {
  if (!audio) {
    audio = new AudioContext();
    sidetone = audio.createOscillator();
    sidetoneGate = audio.createGain();
    masterLevel = audio.createGain();
    sidetoneGate.gain.value = 0;
    // a limiter keeps a very high RF gain loud but not clipping
    const limiter = audio.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 6;
    limiter.ratio.value = 20;
    sidetone.connect(sidetoneGate).connect(masterLevel).connect(limiter).connect(audio.destination);
    sidetone.start();
    applySettings();
  }
  if (audio.state === 'suspended') audio.resume().catch(() => {});
}

export function applySettings() {
  for (const [id, suffix] of [['speed', ' WPM'], ['pitch', ' Hz'], ['vol', '%'], ['latency', ' ms']]) {
    $(id + 'Out').value = $(id).value + suffix;
  }
  if (audio) {
    sidetone.frequency.value = +$('pitch').value;
    masterLevel.gain.setTargetAtTime(.25 * (+$('vol').value / 100) ** 2, audio.currentTime, .01);
  }
}

export function setSidetone(on) {
  if (!audio) return;
  const t = audio.currentTime;
  sidetoneGate.gain.cancelScheduledValues(t);
  sidetoneGate.gain.setTargetAtTime(on ? 1 : 0, t, .002);
}

/**
 * Plays a keyed tone. `runs` is a list of [keyDown, milliseconds] pairs.
 * The tone goes to `destination` (the speaker output by default).
 * Returns { tone, end } where `end` is the performance.now() time playback ends.
 */
export function playRuns(runs, delayMs = 0, hz = +$('pitch').value, destination = masterLevel) {
  enableAudio();
  destination ??= masterLevel;
  const tone = audio.createOscillator();
  const envelope = audio.createGain();
  tone.frequency.value = hz;
  envelope.gain.value = 0;
  tone.connect(envelope).connect(destination);

  const startTime = audio.currentTime + .05 + delayMs / 1000;
  let time = startTime;
  for (const [keyDown, ms] of runs) {
    const end = time + ms / 1000;
    if (keyDown) {
      const ramp = Math.min(.005, (end - time) / 2);
      envelope.gain.setValueAtTime(0, time);
      envelope.gain.linearRampToValueAtTime(.8, time + ramp);
      envelope.gain.setValueAtTime(.8, end - ramp);
      envelope.gain.linearRampToValueAtTime(0, end);
    }
    time = end;
  }

  voices.add(tone);
  tone.onended = () => {
    tone.disconnect();
    envelope.disconnect();
    voices.delete(tone);
  };
  tone.start();
  tone.stop(time + .01);
  return { tone, end: performance.now() + (time - audio.currentTime) * 1000 };
}

let clockOffset = null;   // audio clock minus performance clock, in seconds

/**
 * The AudioContext time rendered at a performance.now() moment; it is heard
 * outputLatencyMs() later. currentTime only advances once per render block, so the highest recent
 * reading is the closest one; it is allowed to drift slowly with the clocks.
 */
export function audioTimeAt(perfMs) {
  const sample = audio.currentTime - performance.now() / 1000;
  const stale = clockOffset === null || clockOffset - sample > .05;   // also after the context was suspended
  clockOffset = stale ? sample : Math.max(sample, clockOffset - .0005);
  return Math.max(audio.currentTime, clockOffset + perfMs / 1000);
}

/** How long, in ms, the device takes to make scheduled audio audible. */
export const outputLatencyMs = () => audio ? ((audio.outputLatency || 0) + (audio.baseLatency || 0)) * 1000 : 0;

export function stopAllVoices() {
  for (const tone of voices) {
    try { tone.stop(); } catch {}
  }
}

/** A keying string ('1' down, '0' up per unit) as runs. */
export const keyingToRuns = (keying, unit) => keying.match(/1+|0+/g).map(run => [run[0] === '1', run.length * unit]);
