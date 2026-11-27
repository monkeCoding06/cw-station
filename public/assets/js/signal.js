/*
 * How strong a remote station arrives here, in dB relative to 100 W over a
 * perfect path, and how loud the band noise is. The parts are independent:
 *   - transmit power, chosen by the sender: 10 * log10(watts / 100)
 *   - the path: a fixed loss for each pair of stations on a band, the same both ways
 *   - fading on that path: a slow wander plus shorter QSB, from the wall clock
 *   - band conditions: slow changes shared by every path on the band
 *   - noise: band noise that drifts over minutes, plus a fixed local level per receiver
 * Everything runs off the wall clock, so both ends of a path fade together and
 * the state carries on through gaps between characters.
 */

export const POWER_LEVELS = [0.5, 1, 2, 5, 10, 25, 50, 100];
export const REFERENCE_WATTS = 100;
export const DEFAULT_WATTS = 100;
export const BAND = '40m';
export const LEVEL = .8;           // tone amplitude at 0 dB, as before power existed
export const MAX_PATH_LOSS = 36;   // dB; on the worst paths even 100 W struggles
export const READABLE_SNR = -3;    // dB in the passband; scan stops on stations at least this clear
const NOISE_RMS = .0311;           // band noise in a 500 Hz passband, same scale as LEVEL
const NOISE_BW = 500;

export const cleanWatts = watts => (POWER_LEVELS.includes(watts) ? watts : DEFAULT_WATTS);
export const powerDb = watts => 10 * Math.log10(cleanWatts(watts) / REFERENCE_WATTS);
export const dbToAmp = db => LEVEL * 10 ** (db / 20);

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

/** A clean path for local playback such as Echo: no loss, no fading, no band conditions. */
export const FLAT_PATH = { baseDb: 0, depthDb: 0, periods: [1, 1], phases: [0, 0], qsbDb: 0, band: false };

/** The path between two stations on a band. Most paths are good; a few are marginal. */
export function pathBetween(a, b, band = BAND) {
  const pair = [String(a).toUpperCase(), String(b).toUpperCase()].sort().join('|');
  const rng = random(hash(band + '|' + pair));
  const loss = rng() ** 2;
  return {
    baseDb: -MAX_PATH_LOSS * loss,
    depthDb: 2 + 3 * loss,                              // worse paths wander further
    periods: [23 + 18 * rng(), 61 + 36 * rng()],        // seconds
    phases: [rng() * 2 * Math.PI, rng() * 2 * Math.PI],
    qsbDb: 1.5 + 3.5 * loss,                            // and fade faster and deeper
    qsbPeriods: [3 + 3 * rng(), 5.5 + 3 * rng(), 9 + 4 * rng()],
    qsbPhases: [rng() * 2 * Math.PI, rng() * 2 * Math.PI, rng() * 2 * Math.PI],
    band: true,
  };
}

const wave = (s, periods, phases, weights) =>
  weights.reduce((sum, w, i) => sum + w * Math.sin(2 * Math.PI * s / periods[i] + phases[i]), 0);

/** Fading on a path in dB at wall-clock `nowMs`, within ±(depthDb + qsbDb). */
export function fadeDb(path, nowMs) {
  const s = nowMs / 1000;
  const slow = path.depthDb * wave(s, path.periods, path.phases, [.6, .4]);
  return path.qsbDb ? slow + path.qsbDb * wave(s, path.qsbPeriods, path.qsbPhases, [.45, .35, .2]) : slow;
}

/** Band conditions on 40 m: everybody comes up and goes down together over tens of minutes, within ±3 dB. */
export const bandDb = nowMs => 3 * wave(nowMs / 1000, [757, 1531], [.7, 2.9], [.6, .4]);

/** Fading and band conditions together: what the path does to a signal right now. */
export const pathDb = (path, nowMs) => fadeDb(path, nowMs) + (path.band ? bandDb(nowMs) : 0);

/** Band noise drift shared by everybody, within ±2 dB, over several minutes. */
export const bandNoiseDb = nowMs => 2 * wave(nowMs / 1000, [419, 1103], [1.9, .4], [.55, .45]);

/** A receiver's own noise above the band's, 0-3 dB: some stations simply live somewhere noisier. */
export const localNoiseDb = call => 3 * random(hash('noise|' + String(call).toUpperCase()))();

/** Noise RMS through a `bw` Hz passband, `noiseDb` above the quiet band. */
export const noiseRms = (bw, noiseDb = 0) => NOISE_RMS * Math.sqrt(bw / NOISE_BW) * 10 ** (noiseDb / 20);

/** Tone-to-noise ratio in dB of a `db` signal centred in a `bw` Hz passband. */
export const snrDb = (db, bw, noiseDb = 0) => 20 * Math.log10(dbToAmp(db) / Math.SQRT2 / noiseRms(bw, noiseDb));

/** One weak local carrier per receiver (a switch-mode supply next door): offset and level. Never a station. */
export function birdieFor(call) {
  const rng = random(hash('birdie|' + String(call).toUpperCase()));
  const side = rng() < .5 ? -1 : 1;
  return { offset: side * Math.round((2000 + 7500 * rng()) / 10) * 10, db: -34 + 5 * rng() };
}

/** Received level in dB of a `watts` signal over `path`, without fading. */
export const steadyDb = (watts, path) => powerDb(watts) + path.baseDb;
