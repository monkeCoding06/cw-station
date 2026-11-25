import { $, api } from './util.js';
import { noteHeard } from './contacts.js';

let callsign, view, timer;
let ready = false;
let sending = false;
const PING_KEY = 'cw-chat-ping';
let pingOn = false;
let pingContext = null;
const request = (action, id, extra = {}, keepalive = false) =>
  api('chat_' + action, {post: {view: id, ...extra}, keepalive});

export function ping(tones = [880, 1320]) {
  if (!pingOn || !pingContext) return;
  pingContext.resume?.();
  const now = pingContext.currentTime;
  tones.forEach((hz, i) => {
    const osc = pingContext.createOscillator();
    const gain = pingContext.createGain();
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0, now + i * .09);
    gain.gain.linearRampToValueAtTime(.15, now + i * .09 + .01);
    gain.gain.exponentialRampToValueAtTime(.001, now + i * .09 + .25);
    osc.connect(gain).connect(pingContext.destination);
    osc.start(now + i * .09);
    osc.stop(now + i * .09 + .26);
  });
}

function initPingToggle() {
  const button = $('chatPing');
  try { pingOn = localStorage.getItem(PING_KEY) === '1'; } catch {}
  const show = () => {
    button.setAttribute('aria-pressed', String(pingOn));
    button.textContent = pingOn ? 'Ping on' : 'Ping off';
  };
  button.onclick = () => {
    pingOn = !pingOn;
    try { localStorage.setItem(PING_KEY, pingOn ? '1' : '0'); } catch {}
    if (pingOn) {
      pingContext ||= new (window.AudioContext || window.webkitAudioContext)();
      ping();
    }
    show();
  };
  document.addEventListener('pointerdown', () => {
    if (pingOn) pingContext ||= new (window.AudioContext || window.webkitAudioContext)();
  }, {once: true});
  show();
}

const receiverOn = () => document.body.classList.contains('rx-on');

function controls() {
  const open = ready && receiverOn();
  $('chatText').disabled = !open;
  $('chatSend').disabled = !open || sending;
  $('chatText').placeholder = ready && !receiverOn() ? 'Turn the receiver on to chat' : 'Say something';
}

export function initChat(call) {
  callsign = call;
  initPingToggle();
  document.addEventListener('cw-power', controls);
  $('chatForm').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('chatText');
    const text = input.value.trim();
    if (!ready || sending || !text || !receiverOn()) return;
    const id = view;
    sending = true;
    controls();
    try {
      await request('send', id, {text});
      if (view !== id) return;
      if (input.value.trim() === text) input.value = '';
      $('chatError').textContent = '';
    } catch (error) {
      if (view === id) $('chatError').textContent = error.message;
    } finally {
      if (view === id) {
        sending = false;
        controls();
        input.focus();
      }
    }
  });
  window.addEventListener('pagehide', leaveChat);
  window.addEventListener('pageshow', event => {
    if (event.persisted && !$('onlinePanel').hidden) enterChat();
  });
}

export function leaveChat() {
  const old = view;
  view = null;
  ready = sending = false;
  clearTimeout(timer);
  controls();
  $('chatLog').replaceChildren();
  $('chatText').value = '';
  $('chatError').textContent = '';
  if (old) request('leave', old, {}, true).catch(() => {});
}

export function enterChat() {
  leaveChat();
  view = crypto.randomUUID();
  poll(view);
}

async function poll(id) {
  try {
    if (!ready) {
      await request('join', id);
      if (view !== id) return;
      ready = true;
      controls();
      $('chatError').textContent = '';
    }
    const {messages = []} = await request('poll', id);
    if (view !== id) return;
    const log = $('chatLog');
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    for (const message of messages) {
      const item = document.createElement('li');
      const who = document.createElement('b');
      who.textContent = message.call;
      if (message.call === callsign) who.className = 'me';
      else noteHeard(message.call);
      item.append(who, ' ', message.text);
      log.append(item);
    }
    while (log.children.length > 50) log.firstChild.remove();
    if (messages.some(message => message.call !== callsign)) ping();
    if (stick) log.scrollTop = log.scrollHeight;
  } catch (error) {
    if (view !== id) return;
    if (error.status === 409) ready = false;
    controls();
    $('chatError').textContent = error.message;
  }
  if (view === id) timer = setTimeout(() => poll(id), 900);
}
