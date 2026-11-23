/** The "Verify your email" banner on signed-in pages. */

import { api } from './api';
import { account } from './panel';
import { $, busy, toast } from './ui';

account().then(({ account }) => {
  const banner = document.querySelector<HTMLElement>('[data-unverified]');
  if (!banner || account.verified) return;
  $('[data-unverified-email]', banner).textContent = account.email;
  banner.hidden = false;
  $('[data-resend]', banner).addEventListener('click', async (event) => {
    try {
      await busy(event.currentTarget as HTMLButtonElement, () => api('verify/resend', { body: {} }));
      toast('Link sent. Check your email.');
    } catch (error) {
      toast((error as Error).message);
    }
  });
});
