import { $ } from './util.js';
import { noteHeard } from './contacts.js';
import { openCallMenu } from './rigview.js';
import { stopAllVoices } from './audio.js';
import { hooks } from './keyer.js';
import { connectLive } from './live.js';
import { createReceiver } from './playback.js';
import { createStreamer } from './transmit.js';
import { isPowered, offsetKHz, resetBand, tuneOffset, update as updateRig } from './rig.js';

/*
 * The General room (shared band, live over the station connection), the Echo
 * room (your own keying played back locally) and Practice (the band and the
 * decoder only). All use the shared rig: a station is heard, and seen on the
 * waterfall, at the frequency its operator was tuned to.
 */

const TICK_INTERVAL_MS = 25;
const ECHO_DELAY_MS = 1000;

let me = '';
let room = null;
let tickTimer;
let live = null;
let streamer = null;
let receiver = null;

export function initRooms(callsign) {
  me = callsign;
  window.addEventListener('pagehide', () => {
    if (room === 'general') leaveRoom();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted && !room && !$('onlinePanel').hidden) enterRoom('general');
  });
  // a receiver switched off mid-mark must not leave the key down on the air
  document.addEventListener('cw-power', () => {
    if (!isPowered()) streamer?.release();
  });
}

export function enterRoom(name) {
  room = name;
  resetBand();

  if (name === 'general') {
    receiver = createReceiver();
    streamer = createStreamer({ send: packet => live?.send(packet), frequency: tuneOffset, canSend: isPowered });
    live = connectLive({
      onWelcome: () => streamer.start(),
      onMessage: receiveLive,
      onDown: () => {
        streamer.stop();
        receiver.clear();
      },
      onStatus: text => { $('cwConnection').textContent = text; },
    });
  } else if (name === 'echo') {
    const echo = createReceiver({ fixedDelay: ECHO_DELAY_MS });
    receiver = echo;
    streamer = createStreamer({ send: packet => echo.handle('echo', packet, performance.now()), frequency: tuneOffset });
    streamer.start();
  }

  hooks.key = streamer ? streamer.key : () => {};
  tickTimer = setInterval(tick, TICK_INTERVAL_MS);
}

export function leaveRoom() {
  live?.close();
  streamer?.stop();
  receiver?.clear();
  live = streamer = receiver = null;
  room = null;
  $('cwConnection').textContent = '';
  clearInterval(tickTimer);
  stopAllVoices();
  hooks.key = hooks.word = hooks.clear = () => {};
}

function receiveLive(message, arrival) {
  if (message.t === 'key') {
    noteHeard(message.call);
    receiver.handle(message.sid, message, arrival);
  } else if (message.t === 'end') {
    receiver.end(message.sid, performance.now());
  }
}

/** Retunes playing signals to the dial and reports who is on the air to the waterfall. */
function tick() {
  const { signals, active } = receiver ? receiver.tick(performance.now()) : { signals: [], active: [] };
  if (extraSignals) signals.push(...extraSignals());
  updateRig(signals, active);
}

/** Lets another source, such as the Tune in training band, put signals on the receiver each tick. */
let extraSignals = null;
export const setExtraSignals = fn => { extraSignals = fn; };

const ACTIVITY_LABELS = { general: 'on air', scanning: 'scanning', echo: 'echo', practice: 'practice', training: 'training', inactive: 'inactive' };

let onlineSignature = '';

export function showOnline(stations) {
  const signature = JSON.stringify(stations);
  if (signature === onlineSignature) return;
  onlineSignature = signature;
  const list = $('onlineList');
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.call : null;

  $('onlineCount').textContent = stations.length;
  list.replaceChildren(...stations.map(({ call, listening, activity, freq }) => {
    const item = document.createElement('li');
    if (call === me) {
      item.textContent = call;
      item.className = 'me';
    } else {
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'call';
      name.textContent = call;
      name.dataset.call = call;
      name.onclick = () => openCallMenu(call, name);
      item.append(name);
    }
    const quiet = listening && activity !== 'inactive' && activity !== 'scanning';
    const state = quiet ? 'listening' : activity;
    const base = quiet ? 'just receiving' : ACTIVITY_LABELS[activity];
    const label = base && activity === 'general' && !quiet && Number.isInteger(freq) ? `${base} · ${offsetKHz(freq)} kHz` : base;
    if (label) {
      const tag = document.createElement('small');
      tag.textContent = label;
      tag.dataset.state = state;
      tag.title = label;
      item.append(' ', tag);
    }
    return item;
  }));
  if (focused) list.querySelector(`[data-call="${CSS.escape(focused)}"]`)?.focus();
}
