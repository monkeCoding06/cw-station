import { $, api } from './util.js';

let callsign, view, timer;
let ready = false;
let sending = false;
const request = (action, id, extra = {}, keepalive = false) =>
  api('chat_' + action, {post: {view: id, ...extra}, keepalive});

function controls() {
  $('chatText').disabled = !ready;
  $('chatSend').disabled = !ready || sending;
}

export function initChat(call) {
  callsign = call;
  $('chatForm').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('chatText');
    const text = input.value.trim();
    if (!ready || sending || !text) return;
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
    const {messages} = await request('poll', id);
    if (view !== id) return;
    const log = $('chatLog');
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    for (const message of messages) {
      const item = document.createElement('li');
      const who = document.createElement('b');
      who.textContent = message.call;
      if (message.call === callsign) who.className = 'me';
      item.append(who, ' ', message.text);
      log.append(item);
    }
    while (log.children.length > 50) log.firstChild.remove();
    if (stick) log.scrollTop = log.scrollHeight;
  } catch (error) {
    if (view !== id) return;
    if (error.status === 409) ready = false;
    controls();
    $('chatError').textContent = error.message;
  }
  if (view === id) timer = setTimeout(() => poll(id), 900);
}
