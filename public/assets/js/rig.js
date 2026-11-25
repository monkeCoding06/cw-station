import { $ } from './util.js';
import { audioContext, enableAudio, masterOutput } from './audio.js';
import { isKeyDown } from './keyer.js';
import * as waterfall from './waterfall.js';
import { BAND_MAX, BAND_MIN, ROWS, SPAN_HZ, VIEW_BINS } from './waterfall.js';
import { clearSpectrum, drawSpectrum, initSpectrum, setTraceColor } from './spectrum.js';

/*
 * The receiver rig shared by every room: tuning dial, waterfall, power,
 * RF gain, IF bandwidth, and the audio chain (noise -> IF filter -> speaker).
 *
 * Rooms send their signals into receiverInput() and report what is on the
 * air each tick via update(), so the waterfall and the filter agree.
 * The waterfall records the whole band; the screen shows a window of it.
 */

const BAND_START_HZ = 7030000;  // offsets everywhere are Hz from 7.030 MHz
const FILTER_ORDER = 4;         // steepness of the receive filter's skirts

let canvas, ctx, picture, pixels;
let powered = false;
let bus, noiseFilter, ifFilter;

/** Other modules can watch the receiver: power(on), active(signals) every tick, reset() on a room change. */
export const listeners = { power: null, active: null, reset: null };
export { SPAN_HZ, BAND_MIN, BAND_MAX };

export const tuneOffset = () => +$('vfo').value;
export const tunedKHz = () => ((BAND_START_HZ + tuneOffset()) / 1000).toFixed(3);
export const isPowered = () => powered;

let rxLevel = 0;
/** Simulated receive level, 0..1: band noise plus the keyed signals that get through the filter. */
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
  for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * .38;
  const noiseSource = audio.createBufferSource();
  noiseSource.buffer = noiseBuffer;
  noiseSource.loop = true;
  noiseFilter = audio.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  // only the noise goes through the IF filter; signals are shaped by filterGain() as they are tuned
  noiseSource.connect(noiseFilter).connect(ifFilter).connect(bus);
  noiseSource.start();
  return bus;
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
  if (powered) draw();
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
  if (powered) draw();
}

/** Marks the receive passband on one pane. */
function shade(c, target) {
  const perHz = target.width / SPAN_HZ;
  const bandwidth = parseInt($('bw').value);
  const left = (tuneOffset() - bandwidth / 2 - windowStart()) * perHz;
  c.fillStyle = 'rgba(255, 255, 255, .07)';
  c.fillRect(left, 0, bandwidth * perHz, target.height);
  c.fillStyle = 'rgba(255, 255, 255, .22)';
  c.fillRect(left, 0, 1, target.height);
  c.fillRect(left + bandwidth * perHz - 1, 0, 1, target.height);
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
  if (powered && ctx) draw();
});

/**
 * Call every few milliseconds. `signals` is [{ offset, amp }]: what is keyed right now.
 * `active` is [{ offset }]: every station in the middle of a transmission, keyed or not.
 */
export function update(signals, active = []) {
  const rfGain = 10 ** (+$('rf').value / 20);

  if (bus) {
    const t = audioContext().currentTime;
    const pitch = +$('pitch').value;
    const bandwidth = parseInt($('bw').value);
    bus.gain.setTargetAtTime(powered && !isKeyDown() ? Math.min(300, rfGain) : 0, t, .004);
    noiseFilter.frequency.value = pitch;
    noiseFilter.Q.value = .8;
    ifFilter.frequency.setTargetAtTime(pitch, t, .012);
    ifFilter.Q.setTargetAtTime(pitch / bandwidth, t, .012);
  }

  if (!powered) {
    rxLevel = 0;
    return;
  }
  const gain = Math.sqrt(rfGain);
  const heard = signals.reduce((sum, s) => sum + s.amp * filterGain(s.offset - tuneOffset()), 0);
  rxLevel = isKeyDown() ? 0 : Math.min(1, .05 * gain + .5 * heard * gain);
  waterfall.record(signals, {
    rfGain,
    listening: !isKeyDown(),
    ownOffset: isKeyDown() ? tuneOffset() : null,
    now: performance.now(),
  });
  draw();
  if (listeners.active) listeners.active(active);
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
  $('bw').addEventListener('change', () => {
    $('bwOut').value = $('bw').value;
    if (powered) draw();
  });
  $('vol').dispatchEvent(new Event('input'));
  $('bw').dispatchEvent(new Event('change'));
  updateTuning();
  setPower(false);    // the receiver is always off after a page load
}
