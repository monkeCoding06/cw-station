import { getDecodedText } from './keyer.js';

/*
 * Turns what the operator keys into transmissions: one per finished word,
 * with the decoded text and the exact key-down/key-up timing.
 *
 * A transmission is { text, lead, marks, freq }:
 *   marks - alternating key-down / key-up durations in ms, starting and ending with key-down
 *   lead  - silence in ms between the end of the previous transmission and this one
 *   freq  - transmit frequency, as Hz offset from 7.030 MHz
 */

const MAX_MS = 5000;
const MAX_MARKS = 199;
const MAX_TEXT = 120;

const clampMs = ms => Math.max(1, Math.min(MAX_MS, Math.round(ms)));

/** Returns keyer hooks (key, word, clear) that call `send(transmission)`. */
export function createTransmitter(send, getFrequency) {
  let marks = [];
  let lead = 0;
  let freq = 0;
  let lastChange = 0;
  let lastKeyUp = null;
  let sentChars = 0;        // how much of the decoded text was already sent

  return {
    key(on, now) {
      if (on && marks.length === 0) {
        lead = lastKeyUp === null ? 0 : clampMs(now - lastKeyUp);
        freq = getFrequency();
      } else {
        marks.push(clampMs(now - lastChange));    // the gap before this press, or the press itself
      }
      if (!on) lastKeyUp = now;
      lastChange = now;
    },

    word() {
      const decoded = getDecodedText();
      const text = decoded.slice(sentChars).trim().slice(0, MAX_TEXT);
      sentChars = decoded.length;
      if (marks.length === 0) return;

      const transmission = { text, lead, freq, marks: marks.slice(0, MAX_MARKS) };
      marks = [];
      send(transmission);
    },

    clear() {
      marks = [];
      sentChars = 0;
      lastKeyUp = null;
    },
  };
}
