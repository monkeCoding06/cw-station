import { hooks, clearMonitor, setKeyingSpeed } from './keyer.js';
import { $ } from './util.js';
import { countTrainCopy } from './awards.js';
import { ALPHABET, PATTERNS, prettify, textToKeying } from './morse.js';
import { enableAudio, keyingToRuns, playRuns, stopAllVoices } from './audio.js';

/*
 * Guided receive trainer. Picking a method loads its whole character sequence
 * and starts at the first character: the character is shown with its pattern,
 * played as sidetone, and you key what you heard. A correct copy advances one
 * position and plays the next character; a wrong one replays the same.
 *
 *   Alphabetical  A-Z
 *   Koch          the LCWO/Koch order, one new character at a time
 *   Farnsworth    the app's own character order; characters are sent at
 *                 FARNSWORTH_CHAR_WPM and the speed knob sets the effective speed,
 *                 which stretches the pause before each repetition
 */

const SEQUENCES = {
  Alphabetical: [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  Koch: [...'KMRSUAPTLOWI.NJEF0Y,VG5/Q9ZH38B?427C1D6X'],
  Farnsworth: [...ALPHABET],
};
const FARNSWORTH_CHAR_WPM = 20;

const ADVANCE_DELAY_MS = 300;
const WRONG_REPLAY_DELAY_MS = 400;

let method = '';
let sequence = [];
let index = 0;
let wrong = 0;
let timer, litTimer;

const speed = () => +$('trainSpeed').value;
const isFarnsworth = () => method === 'Farnsworth';
const charWpm = () => (isFarnsworth() ? Math.max(speed(), FARNSWORTH_CHAR_WPM) : speed());
const current = () => sequence[index];
const active = () => sequence.length > 0 && index < sequence.length;

/** Pause before a Farnsworth repetition: a word space stretched to the effective speed (standard formula). */
function repeatGapMs() {
  const c = charWpm();
  const s = Math.min(speed(), c);
  const stretch = (60 * c - 37.2 * s) / (s * c) * 1000 / 19;
  return 7 * stretch;
}

function cancelPlayback() {
  clearTimeout(timer);
  clearTimeout(litTimer);
  stopAllVoices();
  $('trainLcd').classList.remove('lit');
}

function play() {
  cancelPlayback();
  if (!active()) return;
  enableAudio();
  const { end } = playRuns(keyingToRuns(textToKeying(current()), 1200 / charWpm()));
  const remaining = Math.max(0, end - performance.now());
  $('trainLcd').classList.add('lit');
  litTimer = setTimeout(() => $('trainLcd').classList.remove('lit'), remaining);
  if (isFarnsworth()) timer = setTimeout(play, remaining + repeatGapMs());
}

function show(status) {
  const done = sequence.length > 0 && !active();
  $('trainChar').textContent = done ? '✓' : active() ? current() : '–';
  $('trainMorse').textContent = active() ? prettify(PATTERNS[ALPHABET.indexOf(current())]).split('').join(' ') : '\u00a0';
  const speeds = isFarnsworth() ? ` · chars ${charWpm()} WPM` : '';
  $('trainPos').textContent = sequence.length ? `${method} ${Math.min(index + 1, sequence.length)} / ${sequence.length}${speeds}` : '\u00a0';
  $('trainStatus').textContent = status;
  $('trainReplay').disabled = !active();
  $('trainRestart').disabled = sequence.length === 0;
}

function updateLabels() {
  $('trainSpeedLabel').textContent = isFarnsworth() ? 'Effective speed' : 'Character speed';
  $('trainSpeedOut').value = speed() + ' WPM';
  $('trainVolOut').value = $('vol').value + '%';
  $('trainSpeed').title = isFarnsworth()
    ? `Overall copy speed; characters are sent at ${charWpm()} WPM with extra spacing`
    : 'Speed of the characters';
}

function begin() {
  cancelPlayback();
  index = 0;
  wrong = 0;
  clearMonitor();
  show('Send the character with your paddles');
  $('padDit').focus();
  play();
}

function chooseMethod(name) {
  method = name;
  sequence = SEQUENCES[name] ?? [];
  updateLabels();
  begin();
}

function copy(char) {
  if (!active()) return;
  if (char === current()) {
    index++;
    countTrainCopy();
    cancelPlayback();
    if (active()) {
      show('Correct');
      timer = setTimeout(play, ADVANCE_DELAY_MS);
    } else {
      show(`Complete - ${sequence.length} characters, ${wrong} wrong. Restart to go again`);
      $('trainRestart').focus();
    }
  } else {
    wrong++;
    show(`Not ${char} - listen again`);
    cancelPlayback();
    timer = setTimeout(play, WRONG_REPLAY_DELAY_MS);
  }
}

export function initTraining() {
  $('trainMode').onchange = () => chooseMethod($('trainMode').value);
  $('trainReplay').onclick = () => { clearMonitor(); play(); $('padDit').focus(); };
  $('trainRestart').onclick = begin;

  $('trainSpeed').addEventListener('input', () => { updateLabels(); show($('trainStatus').textContent); if (active()) play(); });
  $('vol').addEventListener('input', updateLabels);
  updateLabels();
}

export function enterTraining() {
  leaveTraining();
  hooks.letter = copy;
  setKeyingSpeed(() => 1200 / charWpm());
}

export function leaveTraining() {
  cancelPlayback();
  method = '';
  sequence = [];
  index = wrong = 0;
  $('trainMode').value = '';
  hooks.letter = () => {};
  setKeyingSpeed();
  clearMonitor();
  updateLabels();
  show('Choose a method');
}
