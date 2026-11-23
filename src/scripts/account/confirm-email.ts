/** Confirm a new email: the token is in the link's fragment, so it never reaches server logs or a Referer. */

import { api } from './api';
import { $, showStep } from './ui';

const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
history.replaceState(null, '', location.pathname);

async function run(): Promise<void> {
  if (!token) return showStep('failed');
  try {
    const result = await api<{ email: string; signedIn: boolean }>('email/confirm', { body: { token } });
    $('[data-new-email]').textContent = result.email;
    ($('[data-continue]') as HTMLAnchorElement).href = result.signedIn ? '/account/settings/' : '/account/sign-in/';
    showStep('done');
  } catch (error) {
    $('[data-failed-reason]').textContent = (error as Error).message;
    showStep('failed');
  }
}

run();
