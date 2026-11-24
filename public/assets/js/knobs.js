import { $ } from './util.js';

/*
 * Rotary knobs. Each .knob drives a hidden <input type="range"> or <select>
 * (named by data-for), so the rest of the app keeps reading plain form values.
 *
 * Drag up/right to turn up, mouse wheel for single steps, arrow keys for
 * single steps and PageUp/PageDown or Shift for ten at a time.
 */

const COARSE_FACTOR = 10;
const WHEEL_NOTCH = 100;
const DEFAULT_SWEEP_DEG = 270;

export function initKnobs() {
  for (const element of document.querySelectorAll('.knob')) makeKnob(element);
}

function makeKnob(element) {
  const field = $(element.dataset.for);
  const isSelect = field.tagName === 'SELECT';
  const min = isSelect ? 0 : +field.min;
  const max = isSelect ? field.options.length - 1 : +field.max;
  // the step can change while the knob is in use (the tuning step button)
  const stepNow = () => (isSelect ? 1 : +field.step || 1);
  const coarseNow = () => (isSelect ? 1 : stepNow() * COARSE_FACTOR);
  const pixelsPerStep = +element.dataset.px || 3;
  const sweep = +element.dataset.sweep || DEFAULT_SWEEP_DEG;

  const read = () => (isSelect ? field.selectedIndex : +field.value);
  const text = () => (isSelect
    ? field.value
    : `${field.value} ${element.dataset.unit || ''}`.trim());

  element.tabIndex = 0;
  element.setAttribute('role', 'slider');
  element.setAttribute('aria-label', element.dataset.label || field.id);
  element.setAttribute('aria-valuemin', min);
  element.setAttribute('aria-valuemax', max);

  const dial = document.createElement('div');
  dial.className = 'knob-dial';
  element.append(dial);

  function draw() {
    const fraction = (read() - min) / (max - min);
    dial.style.transform = `rotate(${(fraction - .5) * sweep}deg)`;
    element.setAttribute('aria-valuenow', read());
    element.setAttribute('aria-valuetext', text());
  }

  /** Moves by a number of steps, snaps to the field's step, and tells the rest of the app. */
  function nudge(steps, stepSize = stepNow()) {
    const before = read();
    const target = Math.min(max, Math.max(min, before + steps * stepSize));
    const snapped = isSelect ? target : Math.round((target - min) / stepNow()) * stepNow() + min;
    if (snapped === before) return;

    if (isSelect) field.selectedIndex = snapped;
    else field.value = snapped;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* drag */
  let dragging = false;
  let lastX = 0, lastY = 0, carry = 0;

  element.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    element.focus();
    element.setPointerCapture(event.pointerId);
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    carry = 0;
  });

  element.addEventListener('pointermove', event => {
    if (!dragging) return;
    carry += (event.clientX - lastX) - (event.clientY - lastY);
    lastX = event.clientX;
    lastY = event.clientY;
    const steps = Math.trunc(carry / pixelsPerStep);
    if (steps) {
      carry -= steps * pixelsPerStep;
      nudge(steps);
    }
  });

  const stopDrag = () => { dragging = false; };
  element.addEventListener('pointerup', stopDrag);
  element.addEventListener('pointercancel', stopDrag);

  /* wheel */
  let wheelCarry = 0;
  element.addEventListener('wheel', event => {
    event.preventDefault();
    const pixels = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
    wheelCarry -= pixels;
    const notches = Math.trunc(wheelCarry / WHEEL_NOTCH);
    if (notches) {
      wheelCarry -= notches * WHEEL_NOTCH;
      nudge(notches, event.shiftKey ? coarseNow() : stepNow());
    }
  }, { passive: false });

  /* keyboard */
  element.addEventListener('keydown', event => {
    const bigStep = event.shiftKey ? coarseNow() : stepNow();
    const actions = {
      ArrowUp: () => nudge(1, bigStep),
      ArrowRight: () => nudge(1, bigStep),
      ArrowDown: () => nudge(-1, bigStep),
      ArrowLeft: () => nudge(-1, bigStep),
      PageUp: () => nudge(1, coarseNow()),
      PageDown: () => nudge(-1, coarseNow()),
      Home: () => nudge(-Infinity),
      End: () => nudge(Infinity),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });

  field.addEventListener('input', draw);
  field.addEventListener('change', draw);
  draw();
}
