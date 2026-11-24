export const $ = id => document.getElementById(id);
export const pick = items => items[Math.floor(Math.random() * items.length)];

/**
 * Calls api.php. Pass `post` for a JSON POST, or `query` for a GET.
 * Throws an Error (with .status) when the server answers with an error.
 */
export async function api(action, { post, query, keepalive = false } = {}) {
  const url = 'api.php?' + new URLSearchParams({ action, ...query });
  const options = { credentials: 'same-origin', keepalive };
  if (post !== undefined) {
    options.method = 'POST';
    options.headers = { 'Content-Type': 'application/json', 'X-CW-Request': '1' };
    options.body = JSON.stringify(post);
  }

  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Request failed');
    error.status = response.status;
    throw error;
  }
  return data;
}
