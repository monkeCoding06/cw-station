import { $, api } from './util.js';
import { audioContext, marksToRuns, playRuns, receiveLatencyMs, stopAllVoices } from './audio.js';
import { hooks } from './keyer.js';
import { createTransmitter } from './transmit.js';
import { filterGain, receiverInput, resetBand, tuneOffset, update as updateRig } from './rig.js';

/*
 * The General room (shared band, via the server), the Echo room (your own
 * keying played back locally) and Practice (the band and the decoder only).
 * All use the shared rig: a station is heard, and seen on the waterfall, at
 * the frequency its operator was tuned to.
 */

const POLL_INTERVAL_MS = 1000;
const TICK_INTERVAL_MS = 25;
const ECHO_DELAY_MS = 1000;
const PLAYBACK_LEAD_MS = 50;       // playRuns starts this long after the requested delay

let me = '';
let room = null;
let generation = 0;                // bumped on every room change, so stale async work stops
let pollTimer, tickTimer;
let view = null;
let connected = false;
const playbackEnd = new Map();     // callsign -> performance.now() when their last word ends
let onAir = [];                    // transmissions being played: { freq, tone, startAt, endAt, runs }

export function initRooms(callsign) {
  me = callsign;
  window.addEventListener('pagehide', () => {
    if (room === 'general') leaveRoom();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted && !room && !$('onlinePanel').hidden) enterRoom('general');
  });
}

export function enterRoom(name) {
  room = name;
  generation++;
  view = name === 'general' ? crypto.randomUUID() : null;
  connected = false;
  resetBand();

  const send = name === 'general' ? sendToServer : name === 'echo' ? echoLocally : () => {};
  const transmitter = createTransmitter(send, tuneOffset);
  hooks.key = transmitter.key;
  hooks.word = transmitter.word;
  hooks.clear = transmitter.clear;

  tickTimer = setInterval(tick, TICK_INTERVAL_MS);
  if (name === 'general') poll(generation);
}

export function leaveRoom() {
  if (view) api('cw_leave', {post: {view}, keepalive: true}).catch(() => {});
  view = null;
  connected = false;
  room = null;
  generation++;
  $('cwConnection').textContent = '';
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  stopAllVoices();
  for (const entry of onAir) entry.level.disconnect();
  playbackEnd.clear();
  onAir = [];
  hooks.key = hooks.word = hooks.clear = () => {};
}

/* ---------- Playback of received transmissions ---------- */

/** Plays a transmission after the receive latency. */
function receive(call, transmission, extraDelayMs = 0) {
  const now = performance.now();
  const earliest = now + receiveLatencyMs() + extraDelayMs;
  if (room === 'general' && (playbackEnd.get(call) || 0) > earliest + 4000) return;
  const afterPreviousWord = (playbackEnd.get(call) || 0) + transmission.lead;
  const start = Math.max(earliest, afterPreviousWord);

  // the tone sits at our pitch plus its distance from the dial; tick() keeps it in step as we tune
  const runs = marksToRuns(transmission.marks);
  const hz = Math.max(25, +$('pitch').value + transmission.freq - tuneOffset());
  const input = receiverInput();
  const level = audioContext().createGain();       // the receive filter's attenuation for this signal
  level.gain.value = filterGain(transmission.freq - tuneOffset());
  level.connect(input);
  const { tone, end } = playRuns(runs, start - now, hz, level);
  playbackEnd.set(call, end);
  onAir.push({ freq: transmission.freq, tone, level, startAt: start + PLAYBACK_LEAD_MS, endAt: end, runs });
}

function isKeyedAt(entry, now) {
  let remaining = now - entry.startAt;
  if (remaining < 0) return false;
  for (const [keyDown, ms] of entry.runs) {
    if (remaining < ms) return keyDown;
    remaining -= ms;
  }
  return false;
}

/** Retunes playing signals to the dial and reports who is on the air to the waterfall. */
function tick() {
  const now = performance.now();
  for (const entry of onAir) if (now >= entry.endAt + 100) entry.level.disconnect();
  onAir = onAir.filter(entry => now < entry.endAt + 100);

  const t = onAir.length ? audioContext().currentTime : 0;
  const pitch = +$('pitch').value;
  const tune = tuneOffset();
  const signals = [];
  const active = [];
  for (const entry of onAir) {
    entry.tone.frequency.setTargetAtTime(Math.max(25, pitch + entry.freq - tune), t, .004);
    entry.level.gain.setTargetAtTime(filterGain(entry.freq - tune), t, .004);
    if (now >= entry.startAt && now <= entry.endAt) active.push({ offset: entry.freq });
    if (isKeyedAt(entry, now)) signals.push({ offset: entry.freq, amp: .8 });
  }
  updateRig(signals, active);
}

/* ---------- Echo room ---------- */

function echoLocally(transmission) {
  receive('ECHO', transmission, ECHO_DELAY_MS);
}

/* ---------- General room: server transport ---------- */

async function sendToServer(transmission) {
  if (!connected) return;
  const mine = generation;
  try {
    await api('cw_send', {post: {view, ...transmission}});
  } catch (error) {
    if (mine !== generation) return;
    if (error.status === 401) location.reload();
    $('cwConnection').textContent = 'CW send failed: ' + error.message;
  }
}

const ACTIVITY_LABELS = { general: 'on air', echo: 'echo', practice: 'practice', training: 'training' };

export function showOnline(stations) {
  $('onlineCount').textContent = stations.length;
  $('onlineList').replaceChildren(...stations.map(({ call, listening, activity }) => {
    const item = document.createElement('li');
    item.textContent = call;
    if (call === me) item.className = 'me';
    const state = listening ? 'listening' : activity;
    const label = listening ? 'just receiving' : ACTIVITY_LABELS[activity];
    if (label) {
      const tag = document.createElement('small');
      tag.textContent = label;
      tag.dataset.state = state;
      tag.title = label;
      item.append(' ', tag);
    }
    return item;
  }));
}

async function poll(mine) {
  try {
    if (!connected) {
      $('cwConnection').textContent = 'Connecting to the CW relay…';
      await api('cw_join', {post: {view}});
      if (mine !== generation) return;
      connected = true;
      $('cwConnection').textContent = '';
    }
    const started = performance.now();
    const data = await api('cw_poll', {post: {view}});
    if (mine !== generation) return;
    if (performance.now() - started < 4000) {
      for (const message of data.messages) receive(message.call, message);
    }
    showOnline(data.online);
  } catch (error) {
    if (mine !== generation) return;
    connected = false;
    stopAllVoices();
    for (const entry of onAir) entry.level.disconnect();
    onAir = [];
    playbackEnd.clear();
    $('cwConnection').textContent = 'CW relay unavailable. Reconnecting…';
    if (error.status === 401) {
      location.reload();
      return;
    }
  }

  pollTimer = setTimeout(() => poll(mine), POLL_INTERVAL_MS);
}
