/*
 * How strong a remote station arrives here, in dB relative to today's full
 * level (100 W over a perfect path). Three independent parts:
 *   - transmit power, chosen by the sender: 10 * log10(watts / 100)
 *   - the path: a fixed loss for each pair of stations on a band, the same both ways
 *   - fading: a slow wander around that loss, from the wall clock
 * Receiver noise is not in here; it stays where it is in rig.js and waterfall.js.
 */

export const POWER_LEVELS = [0.5, 1, 2, 5, 10, 25, 50, 100];
export const REFERENCE_WATTS = 100;
export const DEFAULT_WATTS = 100;
export const BAND = '40m';
export const LEVEL = .8;           // tone amplitude at 0 dB, as before power existed
export const MAX_PATH_LOSS = 24;   // dB; on the worst path 100 W is still readable, 1 W is not
export const SCAN_MIN_DB = -26;    // scan stops on stations at least this strong
const DISPLAY_RANGE_DB = 45;       // waterfall and S-meter: 0 dB is today's brightness, -45 dB is nothing

export const cleanWatts = watts => (POWER_LEVELS.includes(watts) ? watts : DEFAULT_WATTS);
export const powerDb = watts => 10 * Math.log10(cleanWatts(watts) / REFERENCE_WATTS);
export const dbToAmp = db => LEVEL * 10 ** (db / 20);

/** Waterfall and S-meter brightness for a level, on a dB scale like a real panadapter. 0 dB gives LEVEL. */
export const displayLevel = db => LEVEL * Math.min(1.25, Math.max(0, 1 + db / DISPLAY_RANGE_DB));

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function random(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A clean path for local playback such as Echo: no loss, no fading. */
export const FLAT_PATH = { baseDb: 0, depthDb: 0, periods: [1, 1], phases: [0, 0] };

/** The path between two stations on a band. Most paths are good; a few are marginal. */
export function pathBetween(a, b, band = BAND) {
  const pair = [String(a).toUpperCase(), String(b).toUpperCase()].sort().join('|');
  const rng = random(hash(band + '|' + pair));
  const loss = rng() ** 2;
  return {
    baseDb: -MAX_PATH_LOSS * loss,
    depthDb: 2 + 4 * loss,                              // worse paths fade deeper
    periods: [23 + 18 * rng(), 61 + 36 * rng()],        // seconds
    phases: [rng() * 2 * Math.PI, rng() * 2 * Math.PI],
  };
}

/** Fading in dB at wall-clock `nowMs`, within ±depthDb. */
export function fadeDb(path, nowMs) {
  const s = nowMs / 1000;
  const wave = .6 * Math.sin(2 * Math.PI * s / path.periods[0] + path.phases[0])
             + .4 * Math.sin(2 * Math.PI * s / path.periods[1] + path.phases[1]);
  return path.depthDb * wave;
}

/** Received level in dB of a `watts` signal over `path`, without fading. */
export const steadyDb = (watts, path) => powerDb(watts) + path.baseDb;
