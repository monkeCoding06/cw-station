import { $, api, h, isolateKeys } from './util.js';
import { applyLook, clean } from './rigstyle.js';
import { previewStrip } from './faceplate.js';
import { openQslFor } from './qsl.js';

/*
 * Click a callsign in the online list for a small menu. "View rig" opens a read-only
 * preview built from that operator's saved look. It never touches tuning, audio or the session.
 */

let returnFocus = null;

function closeMenu() {
  $('callMenu').hidden = true;
}

export function openCallMenu(call, anchor) {
  const menu = $('callMenu');
  if (!menu.hidden && menu.dataset.call === call) return closeMenu();
  menu.dataset.call = call;
  menu.replaceChildren(
    h('button', { type: 'button', class: 'x-close', 'aria-label': 'Close menu', onclick: closeMenu }, '×'),
    h('button', { type: 'button', onclick: () => { closeMenu(); viewRig(call, anchor); } }, 'View profile'),
    h('button', { type: 'button', onclick: () => { closeMenu(); openQslFor(call); } }, 'Send QSL'),
  );
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(rect.left, innerWidth - menu.offsetWidth - 4)) + 'px';
  menu.style.top = Math.min(rect.bottom + 2, innerHeight - menu.offsetHeight - 4) + 'px';
  menu.querySelector('button:not(.x-close)').focus();
}

function miniRig(call, rig) {
  const preview = h('div', { class: 'rigview' });
  applyLook(preview, rig);
  const dial = h('div', { class: 'knob knob-lg' }, h('div', { class: 'knob-dial' }));
  preview.append(h('div', { class: 'unit' },
    h('div', { class: 'lcd lit' }, h('div', { class: 'mini-dial' }, '7030.000 kHz')),
    previewStrip(call),
    h('div', { class: 'mini-row' }, dial, h('div', { class: 'pad' }, h('span'), h('span')))));
  return preview;
}

function medals(awards) {
  return h('div', { class: 'medals' },
    h('h3', {}, `Awards ${awards.length}`),
    awards.length
      ? h('ul', {}, awards.map(award => h('li', { title: `Unlocks ${award.skin[0]}: ${award.skin[1]}` }, award.title)))
      : h('small', {}, 'None yet'));
}

async function viewRig(call, anchor) {
  returnFocus = anchor;
  const overlay = $('rigView');
  const body = h('div', {}, h('small', { role: 'status' }, 'Loading…'));
  overlay.replaceChildren(h('div', { class: 'dialog', role: 'dialog', 'aria-label': `Rig of ${call}` },
    h('div', { class: 'sheet-head' }, h('strong', {}, call), h('button', { type: 'button', class: 'x-close', 'aria-label': 'Close', onclick: closeView }, '×')),
    body));
  overlay.hidden = false;
  overlay.querySelector('button').focus();
  try {
    const { rig, awards = [] } = await api('rig_get', { query: { call } });
    if (!overlay.hidden) body.replaceChildren(miniRig(call, clean(rig)), medals(awards));
  } catch (error) {
    body.replaceChildren(h('small', { role: 'alert' }, error.message));
  }
}

export function closeView() {
  $('rigView').hidden = true;
  returnFocus?.focus?.();
}

export function initRigView() {
  const overlay = $('rigView');
  isolateKeys(overlay);
  isolateKeys($('callMenu'));
  overlay.addEventListener('keydown', event => { if (event.key === 'Escape') closeView(); });
  overlay.addEventListener('click', event => { if (event.target === overlay) closeView(); });
  $('callMenu').addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  document.addEventListener('click', event => {
    if (!event.target.closest('#callMenu, #onlineList .call')) closeMenu();
  });
}
