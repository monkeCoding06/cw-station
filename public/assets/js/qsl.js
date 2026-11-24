import { $, api, h, isolateKeys } from './util.js';
import { heardStations } from './contacts.js';
import { loggedContacts } from './logbook.js';
import { tunedKHz } from './rig.js';
import { ping } from './chat.js';

/*
 * QSL cards. A card is a snapshot made by the server when it is sent: both callsigns,
 * the UTC date and the sender's design at that moment. No conversation or keying is stored.
 */

const claimed = document.body.dataset.claimed === '1';
const me = document.body.dataset.user;
const STYLES = ['plain', 'border', 'stripe'];
const IMAGE_W = 720, IMAGE_H = 480, IMAGE_MAX_BYTES = 140000;
const imageUrl = hash => 'api.php?' + new URLSearchParams({ action: 'qsl_image', id: hash });

let panel, body, design, tab = 'received', target = '', returnFocus = null;

let shownCount = 0;

export function setQslCount(count) {
  if (count > shownCount) ping([988, 1319, 1760]);
  shownCount = count;
  const badge = $('qslBadge');
  badge.textContent = count;
  badge.hidden = !count;
}

/** The card as the recipient sees it. */
export function renderCard({ from, to, date, freq, design: d }) {
  const card = h('div', { class: 'qsl', 'data-style': d.style });
  card.style.setProperty('--q-bg', d.bg);
  card.style.setProperty('--q-ink', d.ink);
  card.style.setProperty('--q-accent', d.accent);
  const shade = h('div', { class: 'q-shade' });
  shade.style.opacity = d.image ? d.dim / 100 : 1;
  card.append(
    d.image && h('img', { src: imageUrl(d.image), alt: '', loading: 'lazy' }),
    shade,
    h('div', { class: 'q-text' },
      h('span', { class: 'q-tag' }, 'QSL'),
      h('strong', {}, from),
      h('span', {}, 'to ' + to),
      h('time', {}, date + ' UTC' + (freq ? ' · ' + freq + ' kHz' : '')),
      d.note && h('em', {}, d.note)));
  return card;
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

/* ---------- Received ---------- */

async function showReceived() {
  body.replaceChildren(h('small', { role: 'status' }, 'Loading…'));
  try {
    const { cards } = await api('qsl_inbox');
    body.replaceChildren(...(cards.length ? cards.map(item => h('div', { class: 'received' },
      renderCard(item.card),
      h('button', {
        type: 'button', 'aria-label': 'Delete card',
        onclick: async () => {
          await api('qsl_delete', { post: { id: item.id } }).catch(() => {});
          showReceived();
        },
      }, 'Delete'))) : [h('small', {}, 'No cards yet')]));
    if (cards.some(item => !item.seen)) {
      await api('qsl_seen', { post: {} });
      setQslCount(0);
    }
  } catch (error) {
    body.replaceChildren(h('small', { role: 'alert' }, error.message));
  }
}

/* ---------- Send ---------- */

function showSend() {
  const status = h('small', { role: 'status' });
  const preview = h('div', { class: 'qsl-preview' });
  const input = h('input', {
    type: 'text', maxlength: 12, placeholder: 'Callsign', 'aria-label': 'Station worked', autocomplete: 'off',
    autocapitalize: 'characters', spellcheck: 'false', value: target,
  });
  const freqInput = h('input', {
    type: 'text', inputmode: 'decimal', maxlength: 9, size: 9, class: 'freq', 'aria-label': 'Frequency in kHz', value: tunedKHz(),
    autocomplete: 'off', spellcheck: 'false',
  });
  const sendButton = h('button', { type: 'button', class: 'primary' }, 'Send card');
  const validFreq = () => /^\d{1,5}(\.\d{1,3})?$/.test(freqInput.value.trim()) && +freqInput.value >= 100 && +freqInput.value <= 60000;
  const freqText = () => (+freqInput.value.trim()).toFixed(3);

  const redraw = () => {
    target = input.value.trim().toUpperCase();
    status.textContent = '';
    sendButton.disabled = !/^[A-Z0-9/]{3,12}$/.test(target) || target === me || !validFreq();
    preview.replaceChildren(...(target ? [renderCard({ from: me, to: target, date: todayUtc(), freq: validFreq() ? freqText() : '', design })] : []));
  };
  input.oninput = freqInput.oninput = redraw;

  const stations = [...new Set([...heardStations(), ...loggedContacts()])].filter(call => call !== me).slice(0, 12);
  sendButton.onclick = async () => {
    sendButton.disabled = true;
    try {
      await api('qsl_send', { post: { to: target, freq: freqText() } });
      status.textContent = `Sent to ${target}`;
    } catch (error) {
      status.textContent = error.message;
    }
    sendButton.disabled = false;
  };

  body.replaceChildren(...[
    stations.length && h('div', { class: 'chips' }, stations.map(call =>
      h('button', { type: 'button', onclick: () => { input.value = call; redraw(); } }, call))),
    h('div', { class: 'row' }, input, freqInput, h('small', {}, 'kHz'), sendButton),
    preview,
    status,
  ].filter(Boolean));
  redraw();
}

/* ---------- My card ---------- */

function resizeImage(file) {
  return createImageBitmap(file).then(bitmap => {
    const canvas = h('canvas', { width: IMAGE_W, height: IMAGE_H });
    const scale = Math.max(IMAGE_W / bitmap.width, IMAGE_H / bitmap.height);
    const w = bitmap.width * scale, hh = bitmap.height * scale;
    canvas.getContext('2d').drawImage(bitmap, (IMAGE_W - w) / 2, (IMAGE_H - hh) / 2, w, hh);
    for (const quality of [.85, .7, .55, .4, .3]) {
      const data = canvas.toDataURL('image/jpeg', quality).split(',')[1];
      if (data.length * .75 <= IMAGE_MAX_BYTES) return data;
    }
    throw new Error('That image is too detailed to shrink enough');
  });
}

function showDesign() {
  const status = h('small', { role: 'status' });
  const preview = h('div', { class: 'qsl-preview' });
  const redraw = () => preview.replaceChildren(renderCard({ from: me, to: 'CALL', date: todayUtc(), design }));
  const color = (key, label) => h('label', { class: 'color' }, label,
    h('input', { type: 'color', value: design[key], oninput: event => { design[key] = event.target.value; redraw(); } }));

  body.replaceChildren(
    preview,
    h('div', { class: 'row colors' }, color('bg', 'Card'), color('ink', 'Text'), color('accent', 'Accent')),
    h('fieldset', {}, h('legend', {}, 'Style'), STYLES.map(style => h('label', { class: 'chip' },
      h('input', { type: 'radio', name: 'qsl-style', checked: design.style === style, onchange: () => { design.style = style; redraw(); } }),
      h('span', {}, style)))),
    h('input', {
      type: 'text', maxlength: 60, placeholder: 'Note', 'aria-label': 'Card note', value: design.note, autocomplete: 'off',
      oninput: event => { design.note = event.target.value; redraw(); },
    }),
    h('label', { class: 'color' }, 'Shade',
      h('input', { type: 'range', min: 0, max: 80, value: design.dim, oninput: event => { design.dim = +event.target.value; redraw(); } })),
    h('div', { class: 'row' },
      h('input', {
        type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Background image',
        onchange: async event => {
          const file = event.target.files[0];
          if (!file) return;
          status.textContent = 'Uploading…';
          try {
            const { image } = await api('qsl_image_upload', { post: { data: await resizeImage(file) } });
            design.image = image;
            status.textContent = '';
            redraw();
          } catch (error) {
            status.textContent = error.message;
          }
        },
      }),
      h('button', { type: 'button', onclick: () => { design.image = null; redraw(); } }, 'No image')),
    h('div', { class: 'row actions' },
      h('button', {
        type: 'button', class: 'primary',
        onclick: async () => {
          try {
            design = (await api('qsl_design_save', { post: { design } })).design;
            status.textContent = 'Saved';
          } catch (error) {
            status.textContent = error.message;
          }
        },
      }, 'Save card')),
    status);
  redraw();
}

/* ---------- Panel ---------- */

const TABS = { received: ['Received', showReceived], send: ['Send', showSend], design: ['My card', showDesign] };

async function render() {
  for (const [name, button] of Object.entries(panel.tabButtons)) button.setAttribute('aria-pressed', String(name === tab));
  if (!claimed) {
    body.replaceChildren(h('small', {}, 'Claim your callsign to send and receive QSL cards.'));
    return;
  }
  if (tab !== 'received') {
    design = (await api('qsl_design_get').catch(() => ({ design: null }))).design;
    if (!design) {
      body.replaceChildren(h('small', { role: 'alert' }, 'Could not load your card'));
      return;
    }
  }
  TABS[tab][1]();
}

function openPanel(name) {
  tab = name;
  returnFocus = document.activeElement;
  panel.hidden = false;
  render();
  panel.querySelector('button').focus();
}

export function closePanel() {
  panel.hidden = true;
  returnFocus?.focus?.();
}

export function openQslFor(call) {
  target = call;
  openPanel('send');
}

export function initQsl() {
  panel = $('qslPanel');
  body = h('div', { class: 'qsl-body' });
  panel.tabButtons = Object.fromEntries(Object.entries(TABS).map(([name, [label]]) =>
    [name, h('button', { type: 'button', onclick: () => { tab = name; render(); } }, label)]));
  panel.replaceChildren(h('div', { class: 'dialog', role: 'dialog', 'aria-label': 'QSL cards' },
    h('div', { class: 'sheet-head' },
      h('div', { class: 'tabs' }, Object.values(panel.tabButtons)),
      h('button', { type: 'button', onclick: closePanel }, 'Close')),
    body));
  isolateKeys(panel);
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') closePanel(); });
  panel.addEventListener('click', event => { if (event.target === panel) closePanel(); });
  $('qslOpen').onclick = () => openPanel('received');
}
