/**
 * /session/#<gist id>: shows a pi session exported as HTML to a GitHub gist. The HTML runs in a
 * sandboxed frame without allow-same-origin, so it gets an opaque origin and cannot reach pi-rust.com.
 */

interface GistFile {
  filename: string;
  raw_url: string;
  truncated?: boolean;
  content?: string;
}

interface Gist {
  html_url: string;
  description: string | null;
  files: Record<string, GistFile | null>;
}

const frame = document.querySelector<HTMLIFrameElement>('[data-frame]')!;
const state = document.querySelector<HTMLElement>('[data-state]')!;
const heading = document.querySelector<HTMLElement>('[data-heading]')!;
const message = document.querySelector<HTMLElement>('[data-message]')!;
const title = document.querySelector<HTMLElement>('[data-title]')!;
const gistLink = document.querySelector<HTMLAnchorElement>('[data-gist-link]')!;

function showState(head: string, text: string): void {
  frame.hidden = true;
  frame.removeAttribute('srcdoc');
  heading.textContent = head;
  message.textContent = text;
  state.hidden = false;
}

function rateLimitText(response: Response): string {
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  const when = reset ? ` after ${new Date(reset * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' later';
  return `GitHub limits how often gists can be read without signing in. Try again${when}.`;
}

async function show(): Promise<void> {
  const id = decodeURIComponent(location.hash.slice(1)).trim();
  if (!/^[A-Za-z0-9]{1,64}$/.test(id)) {
    showState('No session here', 'A session link ends with # and a gist ID, like pi-rust.com/session/#0123abcd.');
    return;
  }
  showState('Loading the session', 'Fetching the gist from GitHub.');
  gistLink.href = `https://gist.github.com/${id}`;
  gistLink.hidden = false;
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/gists/${id}`, { headers: { Accept: 'application/vnd.github+json' } });
  } catch {
    showState('Could not reach GitHub', 'Check your connection and reload the page.');
    return;
  }
  if (response.status === 404) {
    showState('Session not found', 'The gist does not exist, was deleted, or is private.');
    return;
  }
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    showState('GitHub rate limit reached', rateLimitText(response));
    return;
  }
  if (!response.ok) {
    showState('Could not load the session', `GitHub answered with status ${response.status}. Try again later.`);
    return;
  }
  const gist = (await response.json()) as Gist;
  gistLink.href = gist.html_url;
  const file = Object.values(gist.files).find((entry): entry is GistFile => Boolean(entry && /\.html?$/i.test(entry.filename)));
  if (!file) {
    showState('No session in this gist', 'The gist has no HTML file.');
    return;
  }
  let html = file.content ?? '';
  if (file.truncated || !html) {
    try {
      const raw = await fetch(file.raw_url);
      if (!raw.ok) throw new Error(String(raw.status));
      html = await raw.text();
    } catch {
      showState('Could not load the session', 'The session file is too large to load from GitHub right now. Try again later.');
      return;
    }
  }
  title.textContent = gist.description?.trim() || file.filename;
  document.title = `${title.textContent} | pi-rust`;
  frame.srcdoc = html;
  frame.hidden = false;
  state.hidden = true;
}

window.addEventListener('hashchange', show);
show();
