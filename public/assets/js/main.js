import { $, api } from './util.js';
import { initLogbook, queueGuestUpload } from './logbook.js';
import { initKnobs } from './knobs.js';
import * as chat from './chat.js';

const user = document.body.dataset.user;

if (user) {
  startApp(user);
} else {
  startLogin();
}

/* ---------- Sign in ---------- */

function startLogin() {
  $('loginForm').onsubmit = async event => {
    event.preventDefault();
    try {
      await api('login', { post: { callsign: $('callsign').value, password: $('password').value } });
      location.reload();
    } catch (error) {
      // a claimed callsign asks for its password
      if (error.status === 403) {
        $('password').hidden = false;
        $('password').focus();
      }
      $('loginError').textContent = error.message;
    }
  };
}

/** Guests can give their callsign a password. */
function startClaim() {
  const form = $('claimForm');
  if (!form) return;

  $('claim').onclick = () => {
    form.hidden = !form.hidden;
    if (!form.hidden) $('claimPassword').focus();
  };
  form.onsubmit = async event => {
    event.preventDefault();
    try {
      await api('claim', { post: { password: $('claimPassword').value } });
      // the guest logbook is copied to the server on the next load, as the claimed callsign
      queueGuestUpload(document.body.dataset.user);
      location.reload();
    } catch (error) {
      $('claimError').textContent = error.message;
    }
  };
}

/* ---------- Presence ---------- */

const PING_INTERVAL_MS = 3000;
const LISTEN_KEY = 'cw-just-receiving';

/** Keeps us on the online list in every room, and takes us off it when the page closes. */
function startPresence(onPing) {
  const button = $('listen');
  let listening = localStorage.getItem(LISTEN_KEY) === '1';
  let activity;

  const ping = () => api('ping', { post: { listening, activity } }).then(onPing).catch(error => {
    if (error.status === 401) location.reload();
  });
  const show = () => button.setAttribute('aria-pressed', String(listening));

  button.onclick = () => {
    listening = !listening;
    try { localStorage.setItem(LISTEN_KEY, listening ? '1' : '0'); } catch {}
    show();
    ping();
  };
  show();
  ping();
  setInterval(ping, PING_INTERVAL_MS);
  window.addEventListener('pagehide', () => {
    api('ping', { post: { leave: true }, keepalive: true }).catch(() => {});
  });
  return room => {
    activity = room;
    ping();
  };
}

/* ---------- Main app ---------- */

const SAVED_SETTINGS = ['mode', 'speed', 'pitch', 'vol', 'latency', 'vfo', 'rf', 'bw'];
const SETTINGS_KEY = 'cw-settings-v1';

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    for (const id of SAVED_SETTINGS) {
      if (typeof saved[id] === 'string') $(id).value = saved[id];
    }
  } catch {}
}

function saveSettings() {
  const values = Object.fromEntries(SAVED_SETTINGS.map(id => [id, $(id).value]));
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(values)); } catch {}
}

async function startApp(callsign) {
  // before any await: a message sent while the other modules load must not submit the form natively
  chat.initChat(callsign);

  // loaded only when signed in: these modules expect the app's elements to exist
  const [{ renderReference }, audio, keyer, rooms, rig, scan, training, rigStyle, faceplate, rigEditor, rigView, qsl] = await Promise.all([
    import('./morse.js'),
    import('./audio.js'),
    import('./keyer.js'),
    import('./rooms.js'),
    import('./rig.js'),
    import('./scan.js'),
    import('./training.js'),
    import('./rigstyle.js'),
    import('./faceplate.js'),
    import('./rigeditor.js'),
    import('./rigview.js'),
    import('./qsl.js'),
  ]);

  $('logout').onclick = async () => {
    await api('logout', { post: {} });
    location.reload();
  };

  const setActivity = startPresence(data => {
    rooms.showOnline(data.online);
    qsl.setQslCount(data.qsl || 0);
  });
  startClaim();

  loadSettings();
  renderReference();
  rooms.initRooms(callsign);
  rig.initRig();
  scan.initScan();
  training.initTraining();
  initKnobs();
  rigStyle.initRigStyle();
  faceplate.initFaceplate();
  rigEditor.initRigEditor();
  rigView.initRigView();
  qsl.initQsl();
  initLogbook(document.body.dataset.claimed === '1', callsign);
  keyer.initKeyer();
  $('clearDecoder').onclick = keyer.clearMonitor;
  audio.applySettings();

  for (const id of ['speed', 'pitch', 'vol', 'latency']) $(id).addEventListener('input', audio.applySettings);
  for (const id of ['speed', 'pitch', 'vol', 'latency', 'rf']) $(id).addEventListener('input', saveSettings);
  for (const id of SAVED_SETTINGS) $(id).addEventListener('change', saveSettings);

  let currentRoom = null;

  function switchRoom(name) {
    if (name === currentRoom) return;
    if (currentRoom) {
      rooms.leaveRoom();
      if (currentRoom === 'training') training.leaveTraining();
    }

    currentRoom = name;
    keyer.clearMonitor();

    for (const button of document.querySelectorAll('#rooms button')) {
      button.setAttribute('aria-pressed', button.dataset.room === name);
    }
    for (const element of document.querySelectorAll('[data-rooms]')) {
      element.hidden = !element.dataset.rooms.split(' ').includes(name);
    }

    rooms.enterRoom(name);
    setActivity(name);
    if (name === 'training') training.enterTraining();
  }

  for (const button of document.querySelectorAll('#rooms button')) {
    button.onclick = () => {
      audio.enableAudio();
      switchRoom(button.dataset.room);
    };
  }
  switchRoom('general');
  chat.enterChat();
}
