/**
 * Undo an email change. The token is in the link's fragment, so it never reaches server logs or a Referer,
 * and nothing happens until "Undo the change" is pressed, so a mail scanner that opens the link changes nothing.
 */

import { api, ApiError } from './api';
import { $, busy, showStep } from './ui';

const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
history.replaceState(null, '', location.pathname);
if (!token) showStep('failed');

$('[data-undo]').addEventListener('click', async (event) => {
  $('[data-form-error]').textContent = '';
  try {
    const result = await busy(event.currentTarget as HTMLButtonElement, () => api<{ email: string }>('email/undo', { body: { token } }));
    $('[data-old-email]').textContent = result.email;
    showStep('done');
  } catch (error) {
    // A spent or expired link has its own page; anything else can be tried again.
    if (error instanceof ApiError && error.code === 'invalid_token') {
      $('[data-failed-reason]').textContent = error.message;
      showStep('failed');
    } else {
      $('[data-form-error]').textContent = (error as Error).message;
    }
  }
});
