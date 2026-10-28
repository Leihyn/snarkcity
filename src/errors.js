// Failed requests, explained. A visitor should read what went wrong and what to
// do, not "Failed to fetch". No DOM here, so it runs under `node --test`.

export class HttpError extends Error {
  constructor(status, message) {
    super(message ?? `server error ${status}`);
    this.status = status;
  }
}

// `doing` finishes "while trying to …", e.g. "load the launches".
export function explain(err, doing) {
  const status = err?.status;
  if (status === 404) return `The server could not find what this page asked for while trying to ${doing} (error 404). The page may be older than the server: reload it.`;
  if (status === 429) return `The server is getting too many requests right now, so it could not ${doing}. Wait a minute and try again.`;
  if (status === 502 || status === 503 || status === 504) return `The server is restarting or overloaded, so it could not ${doing} (error ${status}). It usually comes back within a minute.`;
  if (status >= 500) return `The server hit a problem while trying to ${doing} (error ${status}). Try again in a minute; nothing on the chain has changed.`;
  if (status >= 400) return `The server turned the request down while trying to ${doing}: ${err.message}`;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return `The server took too long to ${doing}. It may be busy; try again in a minute.`;
  if (err instanceof TypeError) return `The city's server is not answering, so this page could not ${doing}. It may be restarting, or your connection dropped.`;
  return `Could not ${doing}: ${err?.message ?? err}`;
}
