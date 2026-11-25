import { $, api, h, isolateKeys } from './util.js';
import { queueGuestUpload } from './logbook.js';
import { loadAwards, lockOf } from './awards.js';
import { CHOICES, ORIGINAL, PRESETS, applyDisplay, applyLook, clean, drawTapes, saveRig, savedRig, showRig } from './rigstyle.js';
import { gradientCss } from './waterfall.js';

const LABELS = { face: 'Faceplate', dial: 'Dial', knob: 'Knob', meter: 'Meter' };
const DISPLAY_PRESETS = { gqrx: 'Gqrx', classic: 'Classic', custom: 'Custom' };
const STOP_NAMES = ['Noise floor', 'Weak', 'Medium', 'Strong'];
const SLOT_X = [22, 50, 78];
const TAPE_Y = 70;

let draft, slots, editor, status, awards = [];

const open = () => !editor.hidden;

function slotsFrom(rig) {
  return SLOT_X.map((x, i) => rig.tapes[i] ? { ...rig.tapes[i] } : { t: '', x, y: TAPE_Y });
}

/** Draft as a rig record: only slots with text become captions. */
function draftRig() {
  return clean({ ...draft, tapes: slots.filter(slot => slot.t.trim()).map(slot => ({ ...slot, t: slot.t.trim() })) });
}

function preview() {
  const rig = draftRig();
  applyLook($('bench'), rig);
  applyDisplay(rig.display);
  const gradient = editor.querySelector('.gradient');
  if (gradient) gradient.style.background = gradientCss(rig.display);
  const filled = slots.map((slot, index) => slot.t.trim() ? index : -1).filter(index => index >= 0);
  for (const container of document.querySelectorAll('[data-tapes]')) {
    drawTapes(container, rig, (tape, x, y) => {
      slots[filled[tape]].x = x;
      slots[filled[tape]].y = y;
    });
  }
}

function build() {
  editor.replaceChildren(
    h('div', { class: 'sheet-head' }, h('strong', {}, 'Customize rig')),
    h('div', { class: 'row presets' }, Object.entries(PRESETS).map(([name, preset]) =>
      h('button', { type: 'button', onclick: () => { Object.assign(draft, preset); sync(); } }, name))),
    ...Object.entries(CHOICES).map(([key, values]) => h('fieldset', {},
      h('legend', {}, LABELS[key]),
      values.map(value => {
        const lock = lockOf(awards, key, value);
        return h('label', { class: lock ? 'chip locked' : 'chip', title: lock ? 'Locked: ' + lock.how : null },
          h('input', {
            type: 'radio', name: 'rig-' + key, value, checked: draft[key] === value, disabled: lock !== null,
            onchange: () => { draft[key] = value; preview(); },
          }),
          h('span', {}, value.replace('-', ' ')));
      }))),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', id: 'rigBacklight', checked: draft.backlight, onchange: event => { draft.backlight = event.target.checked; preview(); } }),
      ' Meter backlight'),
    h('fieldset', { class: 'display-colors' },
      h('legend', {}, 'Spectrum & waterfall'),
      h('div', { class: 'gradient', 'aria-hidden': 'true' }),
      h('div', { class: 'row' }, Object.entries(DISPLAY_PRESETS).map(([value, label]) =>
        h('label', { class: 'chip' },
          h('input', {
            type: 'radio', name: 'rig-display', value, checked: draft.display.preset === value,
            onchange: () => { draft.display.preset = value; preview(); },
          }),
          h('span', {}, label)))),
      h('div', { class: 'stops' }, STOP_NAMES.map((name, i) => h('label', {},
        h('input', {
          type: 'color', value: draft.display.colors[i],
          oninput: event => { setCustom(colors => { colors[i] = event.target.value; }); },
        }),
        ' ' + name)),
        h('label', {},
          h('input', { type: 'color', value: draft.display.trace, oninput: event => { draft.display.trace = event.target.value; preview(); } }),
          ' Spectrum trace'))),
    h('fieldset', {},
      h('legend', {}, 'Tape captions'),
      h('div', { class: 'tape-inputs' }, slots.map((slot, index) => h('input', {
        type: 'text', maxlength: 10, placeholder: 'CQ', 'aria-label': `Caption ${index + 1}`, value: slot.t,
        autocomplete: 'off', spellcheck: 'false',
        oninput: event => {
          event.target.value = event.target.value.replace(/[^A-Za-z0-9 /.,?!+-]/g, '');
          slot.t = event.target.value;
          preview();
        },
      })))),
    ...(claimed ? [] : [h('fieldset', { class: 'claim-rig' },
      h('legend', {}, 'Claim callsign'),
      h('input', { type: 'password', id: 'rigClaimPassword', maxlength: 72, placeholder: 'New password (8+ characters)', autocomplete: 'new-password', 'aria-label': 'New password' }),
      h('button', { type: 'button', onclick: claim }, 'Claim'))]),
    h('div', { class: 'row actions' },
      h('button', { type: 'button', class: 'primary', onclick: save }, 'Save'),
      h('button', { type: 'button', onclick: cancel }, 'Cancel'),
      h('button', { type: 'button', onclick: restore }, 'Restore original')),
    (status = h('small', { role: 'status' })),
  );
}

function sync() {
  build();
  preview();
}

/** Editing a stop switches to the custom palette without rebuilding the sheet, so a colour picker stays open. */
function setCustom(change) {
  change(draft.display.colors);
  draft.display.preset = 'custom';
  const radio = editor.querySelector('input[name="rig-display"][value="custom"]');
  if (radio) radio.checked = true;
  preview();
}

async function show() {
  awards = await loadAwards();
  draft = savedRig();
  slots = slotsFrom(draft);
  editor.hidden = false;
  $('bench').dataset.editing = 'true';
  $('rigEdit').setAttribute('aria-expanded', 'true');
  sync();
  editor.querySelector('button')?.focus();
}

function close(rig) {
  editor.hidden = true;
  delete $('bench').dataset.editing;
  $('rigEdit').setAttribute('aria-expanded', 'false');
  showRig(rig);
  $('rigEdit').focus();
}

function cancel() {
  close(savedRig());
}

function restore() {
  draft = clean(ORIGINAL);
  slots = slotsFrom(draft);
  sync();
}

const claimed = document.body.dataset.claimed === '1';

/** Claims the callsign, then stores this draft on the server so the rig follows the account. */
async function claim() {
  try {
    await api('claim', { post: { password: $('rigClaimPassword').value } });
    queueGuestUpload(document.body.dataset.user);
    await api('rig_save', { post: { rig: clean(draftRig()) } });
    location.reload();
  } catch (error) {
    status.textContent = error.message;
  }
}

async function save() {
  try {
    close(await saveRig(draftRig()));
  } catch (error) {
    status.textContent = error.message;
  }
}

export function initRigEditor() {
  editor = $('rigEditor');
  isolateKeys(editor);
  editor.addEventListener('keydown', event => {
    if (event.key === 'Escape') cancel();
  });
  $('rigEdit').onclick = () => (open() ? cancel() : show());
}
