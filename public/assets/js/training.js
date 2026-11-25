import { hooks, clearMonitor, setKeyingSpeed, setInputEnabled, commitLetter, getDecodedText } from './keyer.js';
import { $ } from './util.js';
import { countTrainCopy } from './awards.js';
import { ALPHABET, PATTERNS, prettify, textToKeying, farnsworthTimeline, normalizeText } from './morse.js';
import { enableAudio, keyingToRuns, playRuns, stopAllVoices } from './audio.js';

/*
 * Guided receive trainer.
 *
 *   Alphabetical  A-Z
 *   Koch          the LCWO/Koch order, one new character at a time
 *   Both show one character with its pattern, play it, and score each keyed
 *   letter: correct advances, wrong replays the same character.
 *
 *   Farnsworth    a listening exercise. A short multiword group is played
 *                 with ARRL/PARIS spacing (character speed + effective speed),
 *                 hidden from the screen. Copy it with the paddles, then
 *                 press Check copy.
 */

const SEQUENCES = {
  Alphabetical: [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  Koch: [...'KMRSUAPTLOWI.NJEF0Y,VG5/Q9ZH38B?427C1D6X'],
  Farnsworth: [...ALPHABET],
};
const DEFAULT_CHAR_WPM = 20;
const DEFAULT_EFF_WPM = 10;
const START_KNOWN = 6;
const COUNT_STEP_MS = 1100;   // the server credits one training copy per second

const ADVANCE_DELAY_MS = 300;
const WRONG_REPLAY_DELAY_MS = 400;

let method = '';
let sequence = [];
let index = 0;
let wrong = 0;
let timer, litTimer;

// Farnsworth exercise state
let gen = 0;                  // bumped on every cancel so stale callbacks do nothing
let phase = 'idle';           // idle | receiving | copying | checked
let exercise = '';
let known = START_KNOWN;
let countTimers = [];

const isFarnsworth = () => method === 'Farnsworth';
const isListen = () => method === 'Single letters';

// Single letters: one random hidden letter at a time
let target = '';
let right = 0;
const charWpm = () => +$('trainSpeed').value;
const effWpm = () => Math.min(+$('trainEff').value, charWpm());
const current = () => sequence[index];
const active = () => sequence.length > 0 && index < sequence.length;

/** Two short words from the first `count` characters; rng is injectable for tests. */
export function makeExercise(count = known, rng = Math.random) {
  const pool = SEQUENCES.Farnsworth.slice(0, Math.min(count, SEQUENCES.Farnsworth.length));
  const word = () => Array.from({ length: 2 + Math.floor(rng() * 3) }, () => pool[Math.floor(rng() * pool.length)]).join('');
  return `${word()} ${word()}`;
}

function cancelPlayback() {
  gen++;
  clearTimeout(timer);
  clearTimeout(litTimer);
  countTimers.forEach(clearTimeout);
  countTimers = [];
  stopAllVoices();
  $('trainLcd').classList.remove('lit', 'receiving');
}

function setFarnsworthUi(on) {
  $('trainEffGroup').hidden = !on;
  $('trainCheck').hidden = !on;
  $('trainNext').hidden = !on;
  $('trainCopy').hidden = !on;
  $('trainMorse').hidden = on;
}

/* ======================= per-character methods ======================= */

function play() {
  cancelPlayback();
  if (!active()) return;
  enableAudio();
  const { end } = playRuns(keyingToRuns(textToKeying(current()), 1200 / charWpm()));
  const remaining = Math.max(0, end - performance.now());
  $('trainLcd').classList.add('lit');
  litTimer = setTimeout(() => $('trainLcd').classList.remove('lit'), remaining);
}

function playTarget() {
  cancelPlayback();
  if (!target) return;
  enableAudio();
  const { end } = playRuns(keyingToRuns(textToKeying(target), 1200 / charWpm()));
  $('trainLcd').classList.add('lit');
  litTimer = setTimeout(() => $('trainLcd').classList.remove('lit'), Math.max(0, end - performance.now()));
}

function showListen(status) {
  $('trainChar').textContent = '?';
  $('trainPos').textContent = `Single letters · ${right} right · ${wrong} wrong`;
  $('trainStatus').textContent = status;
  $('trainReplay').disabled = !target;
  $('trainRestart').disabled = false;
}

function nextLetter() {
  cancelPlayback();
  target = SEQUENCES.Alphabetical[Math.floor(Math.random() * 26)];
  clearMonitor();
  showListen('Type the letter you heard');
  playTarget();
}

function copyListen(char) {
  if (!target) return;
  if (char === target) {
    right++;
    countTrainCopy();
    cancelPlayback();
    showListen(`Correct - it was ${target}`);
    target = '';
    timer = setTimeout(nextLetter, 900);
  } else {
    wrong++;
    showListen(`Not ${char} - listen again`);
    cancelPlayback();
    timer = setTimeout(playTarget, WRONG_REPLAY_DELAY_MS);
  }
}

function show(status) {
  if (isListen()) { showListen(status); return; }
  const done = sequence.length > 0 && !active();
  $('trainChar').textContent = done ? '✓' : active() ? current() : '–';
  $('trainMorse').textContent = active() ? prettify(PATTERNS[ALPHABET.indexOf(current())]).split('').join(' ') : '\u00a0';
  $('trainPos').textContent = sequence.length ? `${method} ${Math.min(index + 1, sequence.length)} / ${sequence.length}` : '\u00a0';
  $('trainStatus').textContent = status;
  $('trainReplay').disabled = !active();
  $('trainRestart').disabled = sequence.length === 0;
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

/* ======================= Farnsworth exercise ======================= */

const typedText = () => normalizeText(getDecodedText().replace(/□/g, '?'));

function showCopy(expected) {
  const box = $('trainCopy');
  const typed = typedText();
  box.textContent = '';
  if (expected === undefined) {
    box.textContent = typed ? `Copied: ${typed}` : '';
    return;
  }
  const mark = text => {
    const miss = document.createElement('span');
    miss.className = 'miss';
    miss.textContent = text;
    box.append(miss);
  };
  box.append(`Sent:   ${expected}\nCopied: `);
  [...typed].forEach((c, i) => (c === expected[i] ? box.append(c) : mark(c === ' ' ? '·' : c)));
  if (typed.length < expected.length) mark('_'.repeat(expected.length - typed.length));
}

function showFarnsworth(status) {
  const enabled = {
    trainReplay: phase === 'copying' || phase === 'checked',
    trainCheck: phase === 'copying',
    trainNext: phase === 'copying' || phase === 'checked',
  };
  for (const [id, on] of Object.entries(enabled)) $(id).disabled = !on;
  $('trainRestart').disabled = false;
  $('trainChar').textContent = { receiving: 'Receiving…', copying: 'Copy with your paddles', checked: 'Checked' }[phase] ?? '–';
  $('trainPos').textContent = `Farnsworth · chars ${charWpm()} WPM · effective ${effWpm()} WPM · ${known} characters`;
  $('trainStatus').textContent = status;
}

function startExercise(fresh) {
  cancelPlayback();
  if (fresh || !exercise) exercise = makeExercise();
  clearMonitor();
  $('trainCopy').textContent = '';
  phase = 'receiving';
  setInputEnabled(false);
  showFarnsworth('Listen to the whole transmission');
  enableAudio();
  const mine = gen;
  const { runs } = farnsworthTimeline(exercise, charWpm(), effWpm());
  const { end } = playRuns(runs);
  $('trainLcd').classList.add('receiving');
  timer = setTimeout(() => {
    if (mine !== gen) return;
    $('trainLcd').classList.remove('receiving');
    phase = 'copying';
    setInputEnabled(true);
    showFarnsworth('Key what you heard, then press Check copy');
    $('padDit').focus();
  }, Math.max(0, end - performance.now()));
}

function checkCopy() {
  if (phase !== 'copying') return;
  commitLetter();
  const ok = typedText() === exercise;
  phase = 'checked';
  setInputEnabled(false);
  showCopy(exercise);
  if (ok) {
    const n = exercise.replace(/ /g, '').length;
    for (let i = 0; i < n; i++) countTimers.push(setTimeout(countTrainCopy, i * COUNT_STEP_MS));
    known = Math.min(known + 1, SEQUENCES.Farnsworth.length);
    showFarnsworth('Correct - press Next, or raise the effective speed first');
  } else {
    showFarnsworth('Not quite - compare, then Replay or Next');
  }
  $('trainNext').focus();
}

/** Keeps effective <= character speed, so effective is the knob that gives way. */
function syncSpeeds() {
  const c = $('trainSpeed'), e = $('trainEff');
  if (+e.value <= +c.value) return;
  e.value = c.value;
  e.dispatchEvent(new Event('input'));
}

/* ======================= common ======================= */

function updateLabels() {
  $('trainSpeedOut').value = charWpm() + ' WPM';
  $('trainEffOut').value = effWpm() + ' WPM';
  $('trainVolOut').value = $('vol').value + '%';
}

function begin() {
  cancelPlayback();
  index = 0;
  wrong = 0;
  clearMonitor();
  setInputEnabled(!isListen());
  if (isFarnsworth()) {
    known = START_KNOWN;
    exercise = '';
    startExercise(true);
    return;
  }
  if (isListen()) {
    right = 0;
    target = '';
    nextLetter();
    $('trainType').value = '';
    $('trainType').focus();
    return;
  }
  show('Send the character with your paddles');
  $('padDit').focus();
  play();
}

function chooseMethod(name) {
  cancelPlayback();
  method = name;
  sequence = SEQUENCES[name] ?? [];
  phase = 'idle';
  setInputEnabled(!isListen());
  setFarnsworthUi(isFarnsworth());
  $('trainType').closest('.type-box').hidden = !isListen();
  document.querySelector('.keyer').classList.toggle('typing', isListen());
  $('trainMorse').hidden = isFarnsworth() || isListen();
  hooks.letter = isFarnsworth() ? () => {} : isListen() ? copyListen : copy;
  // Farnsworth is answered at the learner's own sending speed
  setKeyingSpeed(isFarnsworth() ? undefined : () => 1200 / charWpm());
  if (isFarnsworth()) {
    $('trainSpeed').value = DEFAULT_CHAR_WPM;
    $('trainEff').value = DEFAULT_EFF_WPM;
    $('trainSpeed').dispatchEvent(new Event('input'));
    $('trainEff').dispatchEvent(new Event('input'));
  }
  updateLabels();
  begin();
}

export function initTraining() {
  $('trainMode').onchange = () => chooseMethod($('trainMode').value);
  $('trainReplay').onclick = () => {
    if (isListen()) { clearMonitor(); playTarget(); $('trainType').focus(); return; }
    if (isFarnsworth()) { startExercise(false); return; }
    clearMonitor();
    play();
    $('padDit').focus();
  };
  $('trainType').addEventListener('input', () => {
    const field = $('trainType');
    const char = field.value.slice(-1).toUpperCase();
    field.value = '';
    if (isListen() && /[A-Z]/.test(char)) copyListen(char);
  });
  $('trainRestart').onclick = begin;
  $('trainCheck').onclick = checkCopy;
  $('trainNext').onclick = () => startExercise(true);

  $('trainSpeed').addEventListener('input', () => {
    syncSpeeds();
    updateLabels();
    if (isFarnsworth()) showFarnsworth($('trainStatus').textContent);
    else { show($('trainStatus').textContent); if (active()) play(); }
  });
  $('trainEff').addEventListener('input', () => {
    syncSpeeds();
    updateLabels();
    if (isFarnsworth()) showFarnsworth($('trainStatus').textContent);
  });
  $('vol').addEventListener('input', updateLabels);
  updateLabels();
}

export function enterTraining() {
  leaveTraining();
  hooks.text = () => { if (isFarnsworth() && phase === 'copying') showCopy(); };
}

export function leaveTraining() {
  cancelPlayback();
  method = '';
  sequence = [];
  index = wrong = right = 0;
  target = '';
  phase = 'idle';
  exercise = '';
  $('trainMode').value = '';
  hooks.letter = () => {};
  hooks.text = () => {};
  setKeyingSpeed();
  setInputEnabled(true);
  setFarnsworthUi(false);
  $('trainCopy').textContent = '';
  $('trainType').closest('.type-box').hidden = true;
  document.querySelector('.keyer').classList.remove('typing');
  clearMonitor();
  updateLabels();
  show('Choose a method');
}
