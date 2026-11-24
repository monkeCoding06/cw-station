import { api, h } from './util.js';

// the server decides what is earned, this just shows it

const claimed = document.body.dataset.claimed === '1';
let current = [];
let toastTimer = 0;

function toast(award) {
  document.querySelector('.toast')?.remove();
  const [slot, skin] = award.skin;
  const note = h('div', { class: 'toast', role: 'status' }, h('strong', {}, award.title), ` - unlocked ${slot} ${skin}`);
  document.body.append(note);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => note.remove(), 5000);
}

function apply(data) {
  current = data.awards;
  for (const id of data.new ?? []) {
    const award = current.find(item => item.id === id);
    if (award) toast(award);
  }
  return current;
}

export async function loadAwards() {
  try {
    return apply(await api('awards'));
  } catch {
    return current;
  }
}

// call after anything that might unlock something
export function checkAwards() {
  if (claimed) loadAwards();
}

export function countTrainCopy() {
  if (claimed) api('award_train', { post: {} }).then(apply).catch(() => {});
}

// the locked award behind a skin, if any
export function lockOf(awards, slot, value) {
  return awards.find(award => award.skin[0] === slot && award.skin[1] === value && !award.unlocked) ?? null;
}

function awardCard(award) {
  const info = h('span', {},
    h('strong', {}, award.title),
    h('small', {}, award.how),
    h('small', { class: 'reward' }, `Unlocks ${award.skin[0]}: ${award.skin[1]}`));

  if (award.unlocked) {
    return h('li', { class: 'done' }, info, h('b', { class: 'tick', role: 'img', 'aria-label': 'Reached' }, '\u2713'));
  }
  return h('li', {},
    info,
    h('small', {}, `${award.progress} / ${award.goal}`),
    h('progress', { max: award.goal, value: award.progress, 'aria-label': `${award.title}: ${award.progress} of ${award.goal}` }));
}

function renderPage() {
  const page = document.getElementById('awardsPage');
  const done = current.filter(award => award.unlocked).length;
  page.replaceChildren(
    h('h2', {}, 'Awards ', h('span', { class: 'clock' }, `${done} / ${current.length}`)),
    h('ul', { class: 'awards' }, current.map(awardCard)),
    h('p', { class: 'awards-note' }, 'Note: award names have been AI-generated.'),
  );
}

function setOpen(open) {
  document.body.classList.toggle('awards-open', open);
  document.getElementById('awardsTab').setAttribute('aria-pressed', String(open));
  if (open) {
    renderPage();
    loadAwards().then(renderPage);
  }
}

export function closeAwards() {
  if (document.body.classList.contains('awards-open')) setOpen(false);
}

export function initAwardsTab() {
  document.getElementById('awardsTab').onclick = () => setOpen(!document.body.classList.contains('awards-open'));
}
