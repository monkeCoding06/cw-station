import { $ } from './util.js';
import { audioContext, enableAudio, keyingToRuns } from './audio.js';
import { textToKeying } from './morse.js';
import { filterGain, receiverInput, tuneOffset } from './rig.js';

/*
 * "Tune in" training band: a few simulated stations, each on its own frequency
 * and sending at its own speed, looping through made-up exchanges.
 * Everything is generated and played locally. Nothing is sent or stored.
 *
 * The stations feed the normal receiver rig. Each is an oscillator whose
 * pitch and level follow the dial, like a received transmission in the
 * General room, and sample() reports what is keyed so the waterfall,
 * spectrum and meter see it too.
 */

export const STATION_COUNT = 4;
const EDGE_HZ = 2500;          // stations sit within +/- this of 7.030 MHz
const MIN_GAP_HZ = 600;
const LOOKAHEAD_S = 3;
const SCHEDULE_MS = 400;

const PREFIXES = ['DL', 'OE', 'G', 'F', 'I', 'EA', 'PA', 'SM', 'OH', 'OK', 'SP', 'HB', 'ON', 'W', 'K', 'VE', 'JA', 'UA'];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const pick = (list, rng) => list[Math.floor(rng() * list.length)];

export function makeCall(rng = Math.random) {
  const suffix = Array.from({ length: 2 + Math.floor(rng() * 2) }, () => pick([...LETTERS], rng)).join('');
  return `${pick(PREFIXES, rng)}${Math.floor(rng() * 10)}${suffix}`;
}

export function makeMessage(rng = Math.random) {
  const a = makeCall(rng), b = makeCall(rng);
  return pick([
    `CQ CQ DE ${a} ${a} K`,
    `CQ TEST ${a} ${a}`,
    `${a} DE ${b} UR 5NN 5NN BK`,
    `QRZ DE ${a} K`,
    `${a} DE ${b} TNX FER QSO 73 SK`,
    `${a} DE ${b} R R TU 73`,
  ], rng);
}

/** Station frequencies (rounded to 50 Hz) never closer than MIN_GAP_HZ, each with its own speed and strength. */
export function makeBand(rng = Math.random, count = STATION_COUNT) {
  const stations = [];
  while (stations.length < count) {
    const freq = Math.round((rng() * 2 * EDGE_HZ - EDGE_HZ) / 50) * 50;
    if (stations.every(s => Math.abs(s.freq - freq) >= MIN_GAP_HZ)) {
      stations.push({ freq, wpm: 10 + Math.floor(rng() * 19), strength: .3 + rng() * .6 });
    }
  }
  return stations;
}

let running = [];
let timer;

function scheduleMessage(station, startAt) {
  const runs = keyingToRuns(textToKeying(makeMessage()), 1200 / station.wpm);
  const gain = station.key.gain;
  let time = startAt;
  for (const [keyDown, ms] of runs) {
    const end = time + ms / 1000;
    if (keyDown) {
      station.marks.push([time, end]);
      const ramp = Math.min(.005, (end - time) / 2);
      gain.setValueAtTime(0, time);
      gain.linearRampToValueAtTime(.8, time + ramp);
      gain.setValueAtTime(.8, end - ramp);
      gain.linearRampToValueAtTime(0, end);
    }
    time = end;
  }
  station.nextAt = time + 1.5 + Math.random() * 3.5;
}

export function startBand() {
  stopBand();
  enableAudio();
  const audio = audioContext();
  const input = receiverInput();
  running = makeBand().map(spec => {
    const station = { ...spec };
    station.osc = audio.createOscillator();
    station.key = audio.createGain();
    station.level = audio.createGain();
    station.key.gain.value = 0;
    station.level.gain.value = 0;
    station.osc.connect(station.key).connect(station.level).connect(input);
    station.osc.start();
    station.nextAt = audio.currentTime + .3 + Math.random() * 3;
    station.marks = [];
    return station;
  });
  const schedule = () => {
    const horizon = audio.currentTime + LOOKAHEAD_S;
    for (const station of running) {
      while (station.nextAt < horizon) scheduleMessage(station, station.nextAt);
    }
  };
  schedule();
  timer = setInterval(schedule, SCHEDULE_MS);
}

/**
 * Called every receiver tick. Keeps each station's pitch and level in step with the dial,
 * and returns what is keyed right now as waterfall signals.
 */
export function sample() {
  if (!running.length) return [];
  const audio = audioContext();
  const now = audio.currentTime;
  const pitch = +$('pitch').value;
  const tune = tuneOffset();
  const signals = [];
  for (const station of running) {
    const distance = station.freq - tune;
    station.osc.frequency.setTargetAtTime(Math.max(25, pitch + distance), now, .004);
    station.level.gain.setTargetAtTime(station.strength * filterGain(distance), now, .004);
    while (station.marks.length && station.marks[0][1] < now) station.marks.shift();
    const mark = station.marks[0];
    if (mark && mark[0] <= now) signals.push({ offset: station.freq, amp: station.strength });
  }
  return signals;
}

export function stopBand() {
  clearInterval(timer);
  for (const station of running) {
    try { station.osc.stop(); } catch {}
    station.osc.disconnect();
    station.key.disconnect();
    station.level.disconnect();
  }
  running = [];
}
