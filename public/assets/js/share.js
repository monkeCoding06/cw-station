import { $ } from './util.js';
import { BAND_MAX, BAND_MIN, BAND_START_HZ, offsetKHz, setTuneStep, tuneOffset, tuneTo } from './rig.js';

const NUDGE_HZ = 50;           // link lands a little above the sharer so the two aren't zero-beat
const PARAM = 'f';

/** Link to the station, tuned to the current frequency plus the nudge. */
function shareUrl() {
  const offset = Math.min(BAND_MAX, tuneOffset() + NUDGE_HZ);
  const url = new URL(location.origin + location.pathname);
  url.searchParams.set(PARAM, BAND_START_HZ + offset);
  return { url: url.href, offset };
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.style.cssText = 'position:fixed;opacity:0';
    document.body.append(field);
    field.select();
    const ok = document.execCommand('copy');
    field.remove();
    return ok;
  }
}

/** Tunes to the frequency from a shared link, then drops it from the address bar. */
export function applySharedLink() {
  const params = new URLSearchParams(location.search);
  if (!params.has(PARAM)) return;
  const offset = parseInt(params.get(PARAM), 10) - BAND_START_HZ;
  if (Number.isFinite(offset) && offset >= BAND_MIN && offset <= BAND_MAX) {
    if (offset % 100) setTuneStep(true);
    tuneTo(offset);
  }
  params.delete(PARAM);
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
}

export function initShare() {
  const button = $('share');
  const flash = text => {
    button.textContent = text;
    setTimeout(() => { button.textContent = 'Share'; }, 1600);
  };
  button.onclick = async () => {
    const { url, offset } = shareUrl();
    const text = `Meet me on ${offsetKHz(offset)} kHz on CW Station`;
    const message = `${text}: ${url}`;
    // Phones get the system share sheet; desktops copy to the clipboard.
    // The url goes separately for the standard sheet; the wording is in title and text for apps that drop one.
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: text, text, url });
        return;
      } catch (error) {
        if (error.name === 'AbortError') return;
      }
    }
    flash(await copy(message) ? 'Copied' : 'Failed');
  };
}
