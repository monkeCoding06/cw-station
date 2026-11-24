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

export function renderReference() {
  PATTERNS.forEach((pattern, i) => {
    const entry = document.createElement('p');
    entry.textContent = ALPHABET[i] + ' ' + prettify(pattern);
    $('ref').append(entry);
  });
}
