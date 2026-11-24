import { $, api } from './util.js';

/*
 * The station logbook. Claimed callsigns keep it on the server; guests keep it
 * in this browser. Entries are { id, at (unix seconds, 0 = undated), contact, text },
 * newest first. Searching is done here, over everything already loaded.
 */

const GUEST_KEY = 'cw-logbook-guest-v1';
const MAX_GUEST_ENTRIES = 500;

let entries = [];
let claimed = false;

/** Callsigns in the logbook, most recent first. */
export const loggedContacts = () => [...new Set(entries.map(entry => entry.contact.toUpperCase()).filter(Boolean))];

/* ---------- Storage ---------- */

const serverStore = {
  async list() { return (await api('log_list')).entries; },
  async add(entry) { return (await api('log_add', { post: entry })).entry; },
  async remove(id) { await api('log_delete', { post: { id } }); },
};

const guestStore = {
  async list() { return readGuestEntries(); },
  async add({ contact, text }) {
    const all = readGuestEntries();
    const entry = { id: Date.now(), at: Math.floor(Date.now() / 1000), contact, text };
    if (all.length >= MAX_GUEST_ENTRIES) throw new Error('The logbook is full');
    localStorage.setItem(GUEST_KEY, JSON.stringify([entry, ...all]));
    return entry;
  },
  async remove(id) {
    localStorage.setItem(GUEST_KEY, JSON.stringify(readGuestEntries().filter(entry => entry.id !== id)));
  },
};

function readGuestEntries() {
  try {
    const saved = JSON.parse(localStorage.getItem(GUEST_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

const store = () => (claimed ? serverStore : guestStore);

/*
 * Claiming a callsign queues the guest logbook for upload. The next page load
 * (as the claimed callsign) copies it to the server, oldest first and with its
 * original times, removing each entry from the browser once it is stored, so an
 * interrupted upload simply resumes on the next load.
 */
const PENDING_KEY = 'cw-logbook-upload-for';

export const queueGuestUpload = callsign => localStorage.setItem(PENDING_KEY, callsign);
export const cancelGuestUpload = () => localStorage.removeItem(PENDING_KEY);

async function uploadGuestLogbook(callsign) {
  if (localStorage.getItem(PENDING_KEY) !== callsign) return;

  const remaining = readGuestEntries();          // newest first
  while (remaining.length) {
    const entry = remaining[remaining.length - 1];
    await api('log_add', { post: { contact: entry.contact, text: entry.text, at: entry.at } });
    remaining.pop();
    localStorage.setItem(GUEST_KEY, JSON.stringify(remaining));
  }
  localStorage.removeItem(GUEST_KEY);
  cancelGuestUpload();
}

/* ---------- Display ---------- */

const pad = number => String(number).padStart(2, '0');

function utcStamp(seconds) {
  if (!seconds) return 'Earlier notes';
  const d = new Date(seconds * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

function tickClock() {
  const d = new Date();
  $('logClock').textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function matches(entry, query) {
  return entry.contact.toLowerCase().includes(query) || entry.text.toLowerCase().includes(query);
}

function render() {
  const query = $('logSearch').value.trim().toLowerCase();
  const shown = query ? entries.filter(entry => matches(entry, query)) : entries;

  $('logCount').textContent = query ? `${shown.length} of ${entries.length}` : `${entries.length} entries`;
  $('logList').replaceChildren(...shown.map(entryElement));
}

function entryElement(entry) {
  const item = document.createElement('li');

  const head = document.createElement('div');
  head.className = 'entry-head';
  const stamp = document.createElement('time');
  stamp.textContent = utcStamp(entry.at);
  const call = document.createElement('strong');
  call.textContent = entry.contact;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = 'Delete entry';
  remove.setAttribute('aria-label', 'Delete entry');
  remove.onclick = () => deleteEntry(entry.id);
  head.append(stamp, call, remove);

  const body = document.createElement('p');
  body.textContent = entry.text;

  item.append(head, body);
  return item;
}

const say = message => { $('logStatus').textContent = message; };

/* ---------- Actions ---------- */

async function deleteEntry(id) {
  try {
    await store().remove(id);
    entries = entries.filter(entry => entry.id !== id);
    render();
  } catch (error) {
    say(error.message);
  }
}

async function addEntry(event) {
  event.preventDefault();
  const text = $('logText').value.trim();
  if (!text) return;

  try {
    const entry = await store().add({ contact: $('logCall').value.trim().toUpperCase(), text });
    entries = [entry, ...entries];
    $('logText').value = '';
    $('logCall').value = '';
    $('logText').focus();
    render();
    say('');
  } catch (error) {
    say(error.message);
  }
}

export async function initLogbook(isClaimed, callsign) {
  claimed = isClaimed;
  tickClock();
  setInterval(tickClock, 15000);

  $('logForm').onsubmit = addEntry;
  $('logText').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('logForm').requestSubmit();
  });
  $('logSearch').addEventListener('input', render);

  try {
    if (claimed) await uploadGuestLogbook(callsign);
    entries = await store().list();
  } catch (error) {
    say(error.message);
  }
  render();
}
