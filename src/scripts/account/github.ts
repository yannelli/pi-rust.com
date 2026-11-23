/** Sign in with GitHub: the trip to GitHub, and the result it brings back in the address. */

import { api } from './api';

/** Sends the browser to GitHub. `next` is where a sign-in or a confirmation goes afterwards. */
export async function goToGitHub(intent: 'sign-in' | 'connect' | 'reauth', next?: string): Promise<void> {
  const { url } = await api<{ url: string }>('github/start', { body: { intent, next } });
  location.assign(url);
}

const ERRORS: Record<string, string> = {
  expired: 'Your GitHub sign-in expired. Try again.',
  failed: 'Signing in with GitHub did not work. Try again.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  suspended: 'This account is suspended.',
  no_email: 'Your GitHub account needs a verified primary email address. Add one on GitHub, then try again.',
  email_taken: 'The pi-rust account with the email of this GitHub account has another GitHub account connected.',
  taken: 'That GitHub account is connected to another pi-rust account.',
  not_linked: 'GitHub was not connected. Connect it here.',
  mismatch: 'That is not the GitHub account connected to your pi-rust account.',
};

export function githubErrorMessage(code: string): string {
  return ERRORS[code] ?? ERRORS.failed;
}

/** Reads a query parameter and removes it from the address, so a reload does not repeat it. */
export function takeParam(name: string): string | null {
  const url = new URL(location.href);
  const value = url.searchParams.get(name);
  if (value !== null) {
    url.searchParams.delete(name);
    history.replaceState(history.state, '', url);
  }
  return value;
}
