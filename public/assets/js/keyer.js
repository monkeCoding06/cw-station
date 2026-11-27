import { $ } from './util.js';
import { ALPHABET, PATTERNS, prettify } from './morse.js';
import { enableAudio, setSidetone, unitMs } from './audio.js';

/*
 * The transmit key: iambic/straight keyer, input handling and the TX decoder.
 * Rooms plug in by assigning the `hooks` below.
 */

export const hooks = {
  key(on, now) {},     // key went down (on = true) or up
  letter(char) {},
  word() {},           // a word was finished and appended to the decoded text
  text() {},           // decoded text changed
  clear() {},          // the monitor was cleared
};

const LETTER_GAP_UNITS = 2.2;
const WORD_GAP_UNITS = 5.5;
const DAH_THRESHOLD_UNITS = 2;

let inputEnabled = true;
let keyDown = false;
let keyDownAt = 0;
let keyUpAt = null;
let keyingUnit = unitMs;
export function setKeyingSpeed(source = unitMs) { keyingUnit = source; }
let markUnit;               // unit length (ms) captured when the current mark began
let pendingSymbols = '';    // dits/dahs of the letter being keyed
let decodedText = '';
let letterTimer, wordTimer;

export const isKeyDown = () => keyDown;
export const getDecodedText = () => decodedText;

export function setInputEnabled(enabled) {
  inputEnabled = enabled;
  if (!enabled) stopKeyer();
}

/* ======================= TX monitor / decoder ======================= */

function paintMonitor() {
  const monitor = $('rx');
  monitor.textContent = decodedText + '▏';
  monitor.scrollTop = monitor.scrollHeight;
  hooks.text();
}

function finishLetter() {
  if (!pendingSymbols) return;
  const char = ALPHABET[PATTERNS.indexOf(pendingSymbols)] || '□';
  decodedText += char;
  pendingSymbols = '';
  paintMonitor();
  hooks.letter(char);
}

function finishWord() {
  finishLetter();
  if (decodedText && !decodedText.endsWith(' ')) {
    decodedText += ' ';
    paintMonitor();
  }
  hooks.word();
}

/** Opens or closes the transmit key and feeds the decoder. */
function setKey(on) {
  if (keyDown === on) return;
  keyDown = on;
  const now = performance.now();
  $('pad').classList.toggle('on', on);
  document.body.classList.toggle('tx', on);
  setSidetone(on);

  if (on) onKeyDown(now);
  else onKeyUp(now);
  hooks.key(on, now);
}

function onKeyDown(now) {
  clearTimeout(letterTimer);
  clearTimeout(wordTimer);
  if (keyUpAt !== null) {
    const gap = now - keyUpAt;
    if (gap >= WORD_GAP_UNITS * markUnit) finishWord();
    else if (gap >= LETTER_GAP_UNITS * markUnit) finishLetter();
  }
  keyDownAt = now;
  markUnit = keyingUnit();
  $('signal').textContent = prettify(pendingSymbols) + ' ▮';
}

function onKeyUp(now) {
  keyUpAt = now;
  const markMs = now - keyDownAt;
  pendingSymbols += markMs < DAH_THRESHOLD_UNITS * markUnit ? '.' : '-';
  $('signal').textContent = prettify(pendingSymbols) + '   ' + Math.round(markMs) + ' ms';
  letterTimer = setTimeout(finishLetter, LETTER_GAP_UNITS * markUnit);
  wordTimer = setTimeout(finishWord, 6.5 * markUnit);
}

/** Decodes the letter still being keyed, without waiting for the letter gap. */
export function commitLetter() {
  clearTimeout(letterTimer);
  clearTimeout(wordTimer);
  finishLetter();
}

export function clearMonitor() {
  stopKeyer();
  clearTimeout(letterTimer);
  clearTimeout(wordTimer);
  keyUpAt = null;
  decodedText = pendingSymbols = '';
  $('signal').textContent = 'Ready to key';
  hooks.clear();
  paintMonitor();
}

/* ======================= Iambic keyer ======================= */

const DIT = 1, DAH = 2, BOTH = 3;

let heldPaddles = 0;
let lastElement = 0;
let sending = false;
let queuedElement = 0;      // opposite paddle tapped during an element
let squeezing = false;
let squeezeRelease = 0;     // element added by iambic B after a squeeze ends
let keyerTimer;

const oppositeOf = element => (element === DIT ? DAH : DIT);

function sendNextElement() {
  const element = queuedElement || squeezeRelease ||
    (heldPaddles === BOTH ? oppositeOf(lastElement) : heldPaddles);
  queuedElement = squeezeRelease = 0;

  if (!element) {
    sending = false;
    squeezing = false;
    return;
  }

  sending = true;
  lastElement = element;
  squeezing = heldPaddles === BOTH;
  const unit = keyingUnit();
  setKey(true);
  keyerTimer = setTimeout(() => {
    setKey(false);
    keyerTimer = setTimeout(sendNextElement, unit);
  }, unit * (element === DIT ? 1 : 3));
}

function updatePaddles(bits) {
  if (bits === heldPaddles) return;
  const added = bits & ~heldPaddles;
  heldPaddles = bits;

  if ($('mode').value === 'Straight key') {
    setKey(!!bits);
    return;
  }

  if (!sending) {
    if (bits) sendNextElement();
    return;
  }

  if (bits === BOTH) {
    squeezing = true;
    queuedElement = 0;
  } else if (!bits && squeezing) {
    squeezeRelease = $('mode').value === 'Iambic B' ? oppositeOf(lastElement) : 0;
    squeezing = false;
  } else if (added && added !== lastElement) {
    queuedElement = added;
  }
}

export function stopKeyer() {
  clearTimeout(keyerTimer);
  sending = false;
  heldPaddles = pressedKeys = serialBits = mouseButtons = queuedElement = squeezeRelease = lastElement = 0;
  tracking = squeezing = false;
  touches.clear();
  $('padDit').classList.remove('held');
  $('padDah').classList.remove('held');
  setKey(false);
}

/* ======================= Input: mouse and keyboard ======================= */

const KEYS_STORAGE = 'cw-paddle-keys-v1';
const KEY_BINDINGS = {};   // event.code -> DIT or DAH
const keyNames = { dit: 'KeyZ', dah: 'KeyX' };

function applyKeyBindings() {
  for (const code of Object.keys(KEY_BINDINGS)) delete KEY_BINDINGS[code];
  KEY_BINDINGS[keyNames.dit] = DIT;
  KEY_BINDINGS[keyNames.dah] = DAH;
  for (const side of ['dit', 'dah']) {
    $(side + 'Key').textContent = keyNames[side].replace(/^Key|^Digit/, '');
  }
}

/** Lets the user pick the dit and dah keys: click a key button, then press the key. */
function initKeyBindings() {
  try { Object.assign(keyNames, JSON.parse(localStorage.getItem(KEYS_STORAGE))); } catch {}
  applyKeyBindings();

  for (const side of ['dit', 'dah']) {
    const button = $(side + 'Key');
    button.onclick = () => {
      button.textContent = 'Press a key…';
      const capture = e => {
        e.preventDefault();
        e.stopImmediatePropagation();
        window.removeEventListener('keydown', capture, true);
        if (e.code !== 'Escape' && e.code !== 'Space') {
          const other = side === 'dit' ? 'dah' : 'dit';
          if (keyNames[other] === e.code) keyNames[other] = keyNames[side];   // swap instead of clashing
          keyNames[side] = e.code;
          try { localStorage.setItem(KEYS_STORAGE, JSON.stringify(keyNames)); } catch {}
        }
        applyKeyBindings();
      };
      window.addEventListener('keydown', capture, true);
    };
  }
}
const NON_KEY_ELEMENTS = 'button,input,select,textarea,label,summary,details,canvas,a,[data-nokey]';

let mouseButtons = 0;
let pressedKeys = 0;
let serialBits = 0;         // paddles held on the USB serial keyer
let tracking = false;       // a mouse press started on the key surface

const refreshPaddles = () => {
  const bits = mouseButtons | pressedKeys | serialBits | touchBits();
  $('padDit').classList.toggle('held', !!(bits & DIT));
  $('padDah').classList.toggle('held', !!(bits & DAH));
  updatePaddles(bits);
};

/* Touch: the dit and dah buttons are separate paddles; several fingers can squeeze. */
const touches = new Map();      // pointerId -> paddle bit
const touchBits = () => [...touches.values()].reduce((bits, bit) => bits | bit, 0);

function initTouchKey() {
  for (const [id, bit] of [['padDit', DIT], ['padDah', DAH]]) {
    const button = $(id);

    button.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' || !inputEnabled) return;
      e.preventDefault();             // also stops the emulated mouse events
      button.setPointerCapture(e.pointerId);
      enableAudio();
      touches.set(e.pointerId, bit);
      refreshPaddles();
    });

    const release = e => {
      if (touches.delete(e.pointerId)) refreshPaddles();
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
  }
}

/*
 * USB paddle over Web Serial. The firmware sends 'a'/'A' for dit down/up and
 * 'b'/'B' for dah down/up at 921600 baud. The host sends 'h' until the
 * firmware answers 'H'.
 */
const SERIAL_BITS = { a: [DIT, true], A: [DIT, false], b: [DAH, true], B: [DAH, false] };
let serialPort = null;
let helloTimer = 0;

// Tells the firmware a host is connected ('h'); it answers 'H' once it is calibrated.
function startHello(port) {
  const writer = port.writable.getWriter();
  const hello = new Uint8Array([0x68]);
  const send = () => writer.write(hello).catch(() => clearInterval(helloTimer));
  clearInterval(helloTimer);
  helloTimer = setInterval(send, 500);
  send();
  return writer;
}

async function readSerial(port) {
  const reader = port.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!inputEnabled) continue;
      let changed = false;
      for (const byte of value) {
        if (byte === 0x48) {  // 'H': firmware acknowledged our hello
          clearInterval(helloTimer);
          continue;
        }
        const entry = SERIAL_BITS[String.fromCharCode(byte)];
        if (!entry) continue;
        serialBits = entry[1] ? serialBits | entry[0] : serialBits & ~entry[0];
        changed = true;
      }
      if (changed) refreshPaddles();
    }
  } finally {
    reader.releaseLock();
  }
}

function initSerialKey() {
  const button = $('serialKey');
  if (!('serial' in navigator)) return;
  button.parentElement.hidden = false;

  const disconnected = () => {
    serialPort = null;
    serialBits = 0;
    button.classList.remove('active');
    refreshPaddles();
  };

  button.onclick = async () => {
    if (serialPort) {
      const port = serialPort;
      disconnected();
      try { await port.close(); } catch {}
      return;
    }
    let writer;
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 921600 });
      serialPort = port;
      enableAudio();
      button.classList.add('active');
      writer = startHello(port);
      await readSerial(port);
    } catch {}
    clearInterval(helloTimer);
    if (writer) { try { writer.releaseLock(); } catch {} }
    if (serialPort) { try { await serialPort.close(); } catch {} }
    disconnected();
  };
}

/** True for the key pad and for empty page area, but not for other controls. */
function isKeySurface(el) {
  return el.closest('main') && (el.closest('#pad') || !el.closest(NON_KEY_ELEMENTS));
}

const isFormControl = el => /INPUT|SELECT|SUMMARY|BUTTON|TEXTAREA/.test(el.tagName) && !el.closest('#pad');

function onKeyerModeChange() {
  clearMonitor();
  const straight = $('mode').value === 'Straight key';
  $('padDit').textContent = straight ? 'Straight key' : 'Dit  ·';
  $('padDah').hidden = straight;
  $('padDit').setAttribute('aria-label', straight ? 'Straight key' : 'Dit');
}

export function initKeyer() {
  initTouchKey();

  window.addEventListener('contextmenu', e => {
    if (inputEnabled && (tracking || isKeySurface(e.target))) e.preventDefault();
  });

  window.addEventListener('mousedown', e => {
    const ignored = !inputEnabled || e.button > 2 || e.button === 1 || (!tracking && !isKeySurface(e.target));
    if (ignored) return;
    e.preventDefault();
    enableAudio();
    tracking = true;
    mouseButtons = e.buttons & 3;
    refreshPaddles();
  });

  window.addEventListener('mouseup', e => {
    if (!tracking) return;
    mouseButtons = e.buttons & 3;
    tracking = !!mouseButtons;
    refreshPaddles();
  });

  window.addEventListener('keydown', e => {
    if (!inputEnabled || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.code === 'Space') {
      if (isFormControl(e.target)) return;
      e.preventDefault();
      if (!e.repeat) clearMonitor();
      return;
    }

    const paddle = KEY_BINDINGS[e.code];
    const typingInField = e.target.matches('input:not([type=range]),textarea,[contenteditable]');
    if (!paddle || typingInField) return;
    e.preventDefault();
    if (e.repeat) return;
    enableAudio();
    pressedKeys |= paddle;
    refreshPaddles();
  });

  window.addEventListener('keyup', e => {
    const paddle = KEY_BINDINGS[e.code];
    if (!paddle) return;
    pressedKeys &= ~paddle;
    refreshPaddles();
  });

  window.addEventListener('blur', stopKeyer);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopKeyer(); });

  initKeyBindings();
  initSerialKey();
  $('mode').onchange = onKeyerModeChange;
  onKeyerModeChange();
}
