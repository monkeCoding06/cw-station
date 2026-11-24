import { $ } from './util.js';
import { BAND_MAX, BAND_MIN, isPowered, listeners, setTuneStep, tuneOffset, tuneTo } from './rig.js';

/*
 * SCAN looks for the next station above the dial (wrapping at the top of the band).
 * If someone is on the air it winds the dial there at once; on a quiet band it keeps
 * sweeping upward and locks the moment somebody keys up. It then stays put, through
 * pauses and after the transmission, until SCAN is pressed again or the dial is turned.
 */

const BAND_HZ = BAND_MAX - BAND_MIN;
const SWEEP_HZ_PER_S = 4000;       // speed of the dial on a quiet band
const SAME_STATION_HZ = 100;       // the station we are already on does not count as the next one
const MAX_FRAME_S = .1;            // a stalled tab must not make the dial leap

let scanning = false;
let ownTuning = false;             // true while the scanner itself moves the dial
let skipNear = null;               // the station we locked onto last time
let stations = [];                 // everyone mid-transmission right now: [{ offset }]
let sweepAt = 0;                   // dial position while sweeping, kept unrounded
let homing = null;                 // the quick wind to a station: { from, ahead, target, startedAt, ms }
let lastFrame = 0;

const round10 = hz => Math.round(hz / 10) * 10;
const wrap = hz => (hz > BAND_MAX ? hz - BAND_HZ : hz);

function showState() {
  $('scan').setAttribute('aria-pressed', scanning);
}

function setDial(offsetHz, commit) {
  ownTuning = true;
  tuneTo(offsetHz, commit);
  ownTuning = false;
}

function stop() {
  scanning = false;
  homing = null;
  showState();
}

/** The station nearest above `from`, going round the top of the band if need be. */
function nextStation(from) {
  let best = null;
  for (const { offset } of stations) {
    if (skipNear !== null && Math.abs(offset - skipNear) < SAME_STATION_HZ) continue;
    const ahead = offset - from < 0 ? offset - from + BAND_HZ : offset - from;
    if (!best || ahead < best.ahead) best = { offset, ahead };
  }
  return best;
}

function frame(now) {
  if (!scanning) return;
  const seconds = Math.min(MAX_FRAME_S, (now - lastFrame) / 1000);
  lastFrame = now;

  if (!homing) {
    const found = nextStation(sweepAt);
    if (found) {
      homing = { from: sweepAt, ahead: found.ahead, target: found.offset, startedAt: now, ms: Math.min(900, 250 + found.ahead / 25) };
    }
  }

  if (homing) {
    const progress = Math.min(1, (now - homing.startedAt) / homing.ms);
    const eased = progress * progress * (3 - 2 * progress);
    if (progress < 1) {
      setDial(round10(wrap(homing.from + homing.ahead * eased)), false);
    } else {
      setDial(round10(homing.target), true);     // locked: stays here until the user acts
      skipNear = homing.target;
      stop();
      return;
    }
  } else {
    sweepAt = wrap(sweepAt + SWEEP_HZ_PER_S * seconds);
    setDial(round10(sweepAt), false);
    if (skipNear !== null && Math.abs(sweepAt - skipNear) > 3 * SAME_STATION_HZ) skipNear = null;
  }
  requestAnimationFrame(frame);
}

function start() {
  scanning = true;
  homing = null;
  ownTuning = true;
  setTuneStep(true);          // 10 Hz steps, so the dial can wind smoothly and land exactly
  ownTuning = false;
  sweepAt = tuneOffset();
  lastFrame = performance.now();
  showState();
  requestAnimationFrame(frame);
}

export function initScan() {
  $('scan').disabled = !isPowered();
  showState();

  $('scan').onclick = () => (scanning ? stop() : start());

  // turning the knob, clicking the waterfall or switching off stops the scan at once
  $('vfo').addEventListener('input', () => {
    if (ownTuning) return;
    skipNear = null;
    stop();
  });
  listeners.active = list => { stations = list; };
  listeners.power = on => {
    $('scan').disabled = !on;
    skipNear = null;
    stations = [];
    stop();
  };
  listeners.reset = () => {
    skipNear = null;
    stations = [];
    stop();
  };
}
