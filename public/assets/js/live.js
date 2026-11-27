import { api } from './util.js';

/*
 * The live CW connection of one General view: a WebSocket to /live, opened
 * with a single-use ticket from api.php and reopened with backoff when it
 * drops. Nothing is replayed after a reconnect; the relay only pushes what
 * happens from then on.
 */

const MAX_BUFFERED = 64 * 1024;
const RETRY_MS = [500, 1000, 2000, 4000, 8000];

export function connectLive({ onWelcome, onMessage, onDown, onStatus }) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let retryTimer;
  let lastError = '';

  function retry(reason) {
    if (closed) return;
    onStatus((reason || 'CW relay unavailable') + '. Reconnecting…');
    retryTimer = setTimeout(open, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
  }

  async function open() {
    if (closed) return;
    onStatus('Connecting to the CW relay…');
    let ticket;
    try {
      ({ ticket } = await api('live_ticket', { post: {} }));
    } catch (error) {
      if (error.status === 401) location.reload();
      else retry(error.message);
      return;
    }
    if (closed) return;

    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live`);
    let welcomed = false;
    ws = socket;
    socket.onopen = () => socket.send(JSON.stringify({ t: 'hello', ticket }));
    socket.onmessage = event => {
      const arrival = performance.now();
      if (ws !== socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.t === 'welcome') {
        welcomed = true;
        attempt = 0;
        lastError = '';
        onStatus('');
        onWelcome(message);
      } else if (message.t === 'err') {
        lastError = 'CW relay: ' + message.error;
      } else {
        onMessage(message, arrival);
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      if (welcomed) onDown();
      retry(lastError);
      lastError = '';
    };
  }

  open();

  return {
    send(message) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      // the network has stalled: start a fresh stream rather than deliver stale keying
      if (ws.bufferedAmount > MAX_BUFFERED) {
        ws.close();
        return false;
      }
      ws.send(JSON.stringify(message));
      return true;
    },

    close() {
      closed = true;
      clearTimeout(retryTimer);
      const socket = ws;
      ws = null;
      socket?.close(1000);
    },
  };
}
