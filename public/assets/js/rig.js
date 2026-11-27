import { $ } from './util.js';
import { audioContext, enableAudio, masterOutput } from './audio.js';
import { isKeyDown, takeKeyedMs } from './keyer.js';
import * as waterfall from './waterfall.js';
import { BAND_MAX, BAND_MIN, ROWS, SPAN_HZ, VIEW_BINS } from './waterfall.js';
import { clearSpectrum, drawSpectrum, initSpectrum, setTraceColor } from './spectrum.js';
import { bandNoiseDb, birdieFor, dbToAmp, LEVEL, localNoiseDb, noiseRms, powerDb, READABLE_SNR, snrDb } from './signal.js';

/*
 * The receiver rig shared by every room: tuning dial, waterfall, power,
 * RF gain, IF bandwidth, and the audio chain (noise -> IF filter -> speaker).
 *
 * Rooms send their signals into receiverInput() and report what is on the
 * air each tick via update(). Audio, waterfall, spectrum, meter and scan all
 * work from the same levels: signals in dB, noise from signal.js, passband
 * from filterGain(). The waterfall records the whole band; the screen shows a window of it.
 *
 * In General the band also has life of its own: noise that drifts, the odd
 * static crash, and a weak carrier from next door. None of it is a station.
 */

const BAND_START_HZ = 7030000;  // offsets everywhere are Hz from 7.030 MHz
const FILTER_ORDER = 4;         // steepness of the receive filter's skirts
const IMAGE_REJECTION = .03;    // the opposite sideband comes through 30 dB down
const NOISE_AMPLITUDE = .3366;  // white noise that reads noiseRms() after the IF filter
const IF_Q = .6436;             // two equal bandpass sections with Q = IF_Q * pitch / bw are bw wide at -3 dB
const MIN_KEYED_MS = 60;        // scan ignores anything keyed for less than this

let canvas, ctx, picture, pixels;
let powered = false;
let bus, noiseFilter, ifFilter, noiseLevel, crashLevel, birdieTone, birdieLevel;
let band = null;                // General's own band life: { noiseDb, birdie, crash, nextCrashAt }

/** Other modules can watch the receiver: power(on), active(signals) every tick, reset() on a room change. */
export const listeners = { power: null, active: null, reset: null };
export { SPAN_HZ, BAND_MIN, BAND_MAX, BAND_START_HZ };

export const tuneOffset = () => +$('vfo').value;
export const offsetKHz = offsetHz => ((BAND_START_HZ + offsetHz) / 1000).toFixed(3);
export const tunedKHz = () => offsetKHz(tuneOffset());
export const isPowered = () => powered;

let rxLevel = 0;
/** S-meter reading, 0..1: power in the passband, band noise plus whatever gets through the filter. */
export const receiveLevel = () => rxLevel;

/** Left edge of the waterfall, as an offset. It follows the VFO but never leaves the band. */
export const windowStart = () => Math.min(BAND_MAX - SPAN_HZ, Math.max(BAND_MIN, tuneOffset() - SPAN_HZ / 2));

/**
 * How much of a signal `distanceHz` from the dial gets through the receive filter:
 * -3 dB at half the bandwidth, falling away quickly beyond it.
 */
export function filterGain(distanceHz) {
  const halfBandwidth = parseInt($('bw').value) / 2;
  return 1 / Math.sqrt(1 + (distanceHz / halfBandwidth) ** (2 * FILTER_ORDER));
}

/** filterGain() plus the sideband: a station so far below the dial that it beats below zero is the image. */
export const passband = offsetHz => filterGain(offsetHz - tuneOffset()) * (+$('pitch').value + offsetHz - tuneOffset() < 0 ? IMAGE_REJECTION : 1);

/** The audio node that received signals connect to. Created on first use. */
export function receiverInput() {
  enableAudio();
  if (bus) return bus;
  const audio = audioContext();

  bus = audio.createGain();
  bus.gain.value = 0;
  ifFilter = audio.createBiquadFilter();
  ifFilter.type = 'bandpass';
  bus.connect(masterOutput());

  const noiseBuffer = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
  const samples = noiseBuffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * NOISE_AMPLITUDE;
  const noiseSource = audio.createBufferSource();
  noiseSource.buffer = noiseBuffer;
  noiseSource.loop = true;
  noiseFilter = audio.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseLevel = audio.createGain();
  // only the noise goes through the IF filter; signals are shaped by passband() as they are tuned
  noiseSource.connect(noiseLevel).connect(noiseFilter).connect(ifFilter).connect(bus);
  noiseSource.start();

  // static crashes: the same noise, from elsewhere in the buffer, through the same filter
  const crashSource = audio.createBufferSource();
  crashSource.buffer = noiseBuffer;
  crashSource.loop = true;
  crashLevel = audio.createGain();
  crashLevel.gain.value = 0;
  crashSource.connect(crashLevel).connect(noiseFilter);
  crashSource.start(0, .9);

  birdieTone = audio.createOscillator();
  birdieLevel = audio.createGain();
  birdieLevel.gain.value = 0;
  birdieTone.connect(birdieLevel).connect(bus);
  birdieTone.start();
  return bus;
}

/** Turns General's band life on for receiver `call`, or off (null) for the quiet rooms. */
export function setBandActivity(call) {
  band = call ? { localDb: localNoiseDb(call), birdie: birdieFor(call), crash: null, nextCrashAt: 0 } : null;
  if (crashLevel) crashLevel.gain.cancelScheduledValues(0);
  if (crashLevel) crashLevel.gain.value = 0;
}

const noiseDbNow = () => (band ? bandNoiseDb(Date.now()) + band.localDb : 0);

/** A crash is a quick burst of wideband noise that dies away; returns its power over the noise right now. */
function crashPower(now) {
  if (!band) return 0;
  if (now >= band.nextCrashAt) {
    if (band.nextCrashAt) startCrash(now);
    band.nextCrashAt = now + 3000 + Math.random() * 12000;
  }
  const crash = band.crash;
  if (!crash || now < crash.at) return 0;
  return crash.peak * Math.exp(-(now - crash.at) / crash.decayMs);
}

function startCrash(now) {
  const peakDb = 3 + Math.random() * 8;
  const decayMs = 60 + Math.random() * 220;
  band.crash = { at: now, peak: 10 ** (peakDb / 10), decayMs };
  if (!crashLevel || !powered) return;
  const gain = crashLevel.gain, t = audioContext().currentTime + .01;
  gain.cancelScheduledValues(t);
  gain.setValueAtTime(0, t);
  // a crackle of two or three bursts, each a bit weaker
  const tau = decayMs / 2000;
  const bursts = 2 + (Math.random() < .5);
  for (let i = 0, at = t, amp = 10 ** (peakDb / 20); i < bursts; i++) {
    gain.linearRampToValueAtTime(amp, at + .002);
    gain.setTargetAtTime(0, at + .002, tau);
    const gap = .02 + Math.random() * .06;
    if (i < bursts - 1) gain.setValueAtTime(amp * Math.exp(-(gap - .002) / tau), at + gap);
    at += gap;
    amp *= .4 + Math.random() * .3;
  }
}

export function setPower(on) {
  powered = on;
  $('power').setAttribute('aria-pressed', on);
  $('power').setAttribute('aria-label', on ? 'Power: on' : 'Power: off');
  document.body.classList.toggle('rx-on', on);
  if (!on) {
    silence();
    waterfall.clear();
    clearSpectrum();
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  if (listeners.power) listeners.power(on);
  document.dispatchEvent(new Event('cw-power'));
}

export function silence() {
  if (bus) bus.gain.setTargetAtTime(0, audioContext().currentTime, .005);
}

/** A new room is a new band: forget what was recorded. */
export function resetBand() {
  waterfall.clear();
  requestDraw();
  if (listeners.reset) listeners.reset();
}

/**
 * Tunes to an offset (Hz from 7.030 MHz) exactly as if the knob had been turned.
 * A sweep passes `commit = false` while moving, so the setting is saved once, at the end.
 */
export function tuneTo(offsetHz, commit = true) {
  $('vfo').value = Math.min(BAND_MAX, Math.max(BAND_MIN, offsetHz));
  $('vfo').dispatchEvent(new Event('input', { bubbles: true }));
  if (commit) $('vfo').dispatchEvent(new Event('change', { bubbles: true }));
}

/** 10 Hz steps for fine tuning, 100 Hz for finding activity. */
export function setTuneStep(fine) {
  const step = fine ? 10 : 100;
  $('vfo').step = step;
  $('tuneStep').textContent = step + ' Hz';
  $('tuneStep').setAttribute('aria-pressed', fine);
  tuneTo(Math.round(tuneOffset() / step) * step);
}

function updateTuning() {
  const start = windowStart();
  const tuneHz = BAND_START_HZ + tuneOffset();
  $('dial').textContent = (tuneHz / 1000).toFixed(3) + ' kHz';
  $('cursor').style.left = ((tuneOffset() - start) / SPAN_HZ * 100) + '%';

  const ticks = ['t0', 't25', 't50', 't75', 't100'];
  ticks.forEach((name, i) => {
    document.querySelector('.scale .' + name).textContent = ((BAND_START_HZ + start + i * SPAN_HZ / 4) / 1000).toFixed(2);
  });
  requestDraw();
}

/** Marks the receive passband on one pane: a tinted band between two bright edges. */
function shade(c, target) {
  const perHz = target.width / SPAN_HZ;
  const bandwidth = parseInt($('bw').value);
  const left = Math.round((tuneOffset() - bandwidth / 2 - windowStart()) * perHz);
  const width = Math.round(bandwidth * perHz);
  c.fillStyle = 'rgba(255, 255, 255, .09)';
  c.fillRect(left, 0, width, target.height);
  c.fillStyle = 'rgba(255, 236, 170, .55)';
  c.fillRect(left - 1, 0, 2, target.height);
  c.fillRect(left + width - 1, 0, 2, target.height);
}

// Drawing waits for the next frame, so a slow phone drops frames rather than delaying keying and audio.
let drawQueued = false;
function requestDraw() {
  if (drawQueued || !powered || !ctx) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    if (powered) draw();
  });
}

/** Shows the part of the recorded band that is under the dial, in both panes, with the receive passband marked. */
function draw() {
  waterfall.render(pixels, windowStart());
  ctx.putImageData(picture, 0, 0);
  shade(ctx, canvas);
  drawSpectrum(windowStart(), shade);
}

/** New spectrum and waterfall colours; the history is recoloured in place. */
document.addEventListener('cw-display', event => {
  waterfall.setPalette(event.detail);
  setTraceColor(event.detail.trace);
  requestDraw();
});

/**
 * Call every few milliseconds. `signals` is [{ offset, amp, db?, duty? }]: what was keyed since
 * the last call; live stations give their received level in dB as well.
 * `active` is [{ offset, db?, keyedMs? }]: every station in the middle of a transmission, keyed or not.
 */
let lastUpdateAt = null;

export function update(signals, active = []) {
  const rfDb = +$('rf').value;
  const rfGain = 10 ** (rfDb / 20);
  const bandwidth = parseInt($('bw').value);
  const now = performance.now();
  const noiseDb = noiseDbNow();
  const crash = crashPower(now);
  // our own keying draws a trace at the TX frequency; muting is audio and meter only
  const keyed = takeKeyedMs(now);
  const tickMs = lastUpdateAt !== null && now - lastUpdateAt < 250 ? Math.max(1, now - lastUpdateAt) : 25;
  lastUpdateAt = now;
  const heard = band ? [...signals, { offset: band.birdie.offset + 3 * Math.sin(now / 41000), db: band.birdie.db }] : signals;

  if (bus) {
    const t = audioContext().currentTime;
    const pitch = +$('pitch').value;
    bus.gain.setTargetAtTime(powered && !isKeyDown() ? Math.min(300, rfGain) : 0, t, .004);
    noiseLevel.gain.setTargetAtTime(10 ** (noiseDb / 20), t, .05);
    for (const filter of [noiseFilter, ifFilter]) {
      filter.frequency.setTargetAtTime(pitch, t, .012);
      filter.Q.setTargetAtTime(IF_Q * pitch / bandwidth, t, .012);
    }
    const birdie = band && heard[heard.length - 1];
    if (birdie) birdieTone.frequency.setTargetAtTime(Math.max(20, Math.abs(pitch + birdie.offset - tuneOffset())), t, .012);
    birdieLevel.gain.setTargetAtTime(birdie ? dbToAmp(birdie.db) * passband(birdie.offset) : 0, t, .03);
  }

  if (!powered) {
    rxLevel = 0;
    return;
  }
  // S-meter: everything in the passband, on a dB scale like a real one
  const noisePower = (noiseRms(bandwidth, noiseDb) / LEVEL) ** 2 * 2 * (1 + crash);
  const signalPower = heard.reduce((sum, s) => {
    const amp = (s.db === undefined ? s.amp / LEVEL : 10 ** (s.db / 20)) * passband(s.offset);
    return sum + amp * amp * (s.duty ?? 1);
  }, 0);
  const meterDb = 10 * Math.log10(noisePower + signalPower) + Math.min(20, rfDb) / 2;
  rxLevel = isKeyDown() ? 0 : Math.min(1, Math.max(0, (meterDb + 32) / 40));

  waterfall.record(heard, {
    rfGain,
    own: keyed > 0 ? { offset: tuneOffset(), db: powerDb(parseFloat($('pwr').value)), duty: Math.min(1, keyed / tickMs) } : null,
    now,
    noiseDb: noiseDb + 10 * Math.log10(1 + crash),
  });
  requestDraw();
  // scan hears a station as it would sound centred in this passband, on this band, now
  if (listeners.active) {
    listeners.active(active.filter(s => (s.db === undefined || snrDb(s.db, bandwidth, noiseDb) >= READABLE_SNR) && (s.keyedMs ?? Infinity) >= MIN_KEYED_MS));
  }
}

export function initRig() {
  canvas = $('water');
  canvas.width = VIEW_BINS;
  canvas.height = ROWS;
  ctx = canvas.getContext('2d');
  picture = ctx.createImageData(VIEW_BINS, ROWS);
  pixels = new Uint32Array(picture.data.buffer);
  initSpectrum($('spectrum'));

  $('power').onclick = () => {
    receiverInput();
    setPower(!powered);
  };
  $('vfo').oninput = updateTuning;
  const tuneFromClick = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetHz = windowStart() + (e.clientX - rect.left) / rect.width * SPAN_HZ;
    const step = +$('vfo').step;
    tuneTo(Math.round(offsetHz / step) * step);
  };
  canvas.onclick = tuneFromClick;
  $('spectrum').onclick = tuneFromClick;
  $('tuneStep').onclick = () => setTuneStep($('vfo').step === '100');
  $('rf').oninput = () => { $('rfOut').value = $('rf').value + ' dB'; };
  $('rf').oninput();
  $('vol').addEventListener('input', () => { $('volOut').value = $('vol').value + '%'; });
  $('pwr').addEventListener('change', () => {
    if ($('pwr').selectedIndex < 0) $('pwr').value = '100 W';
    $('pwrOut').value = $('pwrKnobOut').value = $('pwr').value;
  });
  $('pwr').dispatchEvent(new Event('change'));
  $('bw').addEventListener('change', () => {
    $('bwOut').value = $('bw').value;
    requestDraw();
  });
  $('vol').dispatchEvent(new Event('input'));
  $('bw').dispatchEvent(new Event('change'));
  updateTuning();
  setPower(false);    // the receiver is always off after a page load
}
