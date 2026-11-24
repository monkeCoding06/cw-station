import { $, h, isolateKeys } from './util.js';
import { CHOICES, ORIGINAL, PRESETS, applyLook, clean, drawTapes, saveRig, savedRig, showRig } from './rigstyle.js';

const LABELS = { face: 'Faceplate', dial: 'Dial', knob: 'Knob', meter: 'Meter' };
const SLOT_X = [22, 50, 78];
const TAPE_Y = 70;

let draft, slots, editor, status;

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
      values.map(value => h('label', { class: 'chip' },
        h('input', {
          type: 'radio', name: 'rig-' + key, value, checked: draft[key] === value,
          onchange: () => { draft[key] = value; preview(); },
        }),
        h('span', {}, value.replace('-', ' ')))))),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', id: 'rigBacklight', checked: draft.backlight, onchange: event => { draft.backlight = event.target.checked; preview(); } }),
      ' Meter backlight'),
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

function show() {
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
