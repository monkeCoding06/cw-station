import { $ } from './util.js';

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,?/=-+';
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const PATTERNS = ('.- -... -.-. -.. . ..-. --. .... .. .--- -.- .-.. -- -. --- .--. --.- .-. ... - ..- ...- .-- -..- -.-- --.. ' +
  '----- .---- ..--- ...-- ....- ..... -.... --... ---.. ----. .-.-.- --..-- ..--.. -..-. -...- -....- .-.-.').split(' ');

export const prettify = pattern => pattern.replaceAll('.', '·').replaceAll('-', '−');

/** Converts text to a keying string: '1' = key down, '0' = key up, one char per unit. */
export function textToKeying(text) {
  const wordToKeying = word => Array.from(word, char => PATTERNS[ALPHABET.indexOf(char)] || '')
    .map(pattern => Array.from(pattern, el => (el === '.' ? '1' : '111')).join('0'))
    .join('000');
  return text.trim().split(/ +/).map(wordToKeying).join('0000000');
}

/** Upper case, unknown characters dropped, runs of whitespace collapsed to one space. */
export const normalizeText = text => text.toUpperCase().replace(/\s+/g, ' ').replace(/[^A-Z0-9.,?/=+\- ]/g, '').replace(/ +/g, ' ').trim();

/**
 * Farnsworth timing in ms (ARRL/PARIS). Marks and gaps inside a character run at charWpm;
 * the silence between characters and words is stretched so PARIS takes 60000 / effWpm.
 * PARIS is 31 units of marks and internal gaps plus 19 spacing units (4 x 3 letter + 7 word).
 */
export function farnsworthTiming(charWpm, effWpm) {
  const dit = 1200 / charWpm;
  const unit = (60000 / effWpm - 31 * dit) / 19;
  return { dit, dah: 3 * dit, intra: dit, letter: 3 * unit, word: 7 * unit };
}

/**
 * Playback timeline for `text`: runs of [keyDown, ms] plus the start time of every character.
 * Each boundary contributes exactly one silence; a word boundary replaces the letter boundary.
 * The timeline ends on the last mark, so nothing trails after the final element.
 */
export function farnsworthTimeline(text, charWpm, effWpm) {
  const t = farnsworthTiming(charWpm, effWpm);
  const runs = [];
  const starts = [];
  let clock = 0;
  let gap = null;
  const words = normalizeText(text).split(' ').filter(Boolean);
  words.forEach((word, w) => {
    [...word].forEach((char, c) => {
      const pattern = PATTERNS[ALPHABET.indexOf(char)];
      starts.push({ char, start: clock + (gap ?? 0) });
      [...pattern].forEach((element, e) => {
        if (gap !== null) {
          runs.push([false, gap]);
          clock += gap;
        }
        const ms = element === '.' ? t.dit : t.dah;
        runs.push([true, ms]);
        clock += ms;
        gap = t.intra;
        if (e === pattern.length - 1) gap = c === word.length - 1 ? (w === words.length - 1 ? null : t.word) : t.letter;
      });
    });
  });
  return { runs, starts, total: clock };
}

export function renderReference() {
  PATTERNS.forEach((pattern, i) => {
    const entry = document.createElement('p');
    entry.textContent = ALPHABET[i] + ' ' + prettify(pattern);
    $('ref').append(entry);
  });
}
