/** Account: the address, changing it, its verification, and account deletion. */

import { api, type Account } from './api';
import { account, confirmAction, reportError, sensitive } from './panel';
import './verify-banner';
import { $, busy, clearErrors, formatDate, input, setFieldError, showError, toast } from './ui';

function show(info: Account): void {
  $('[data-email]').textContent = info.email;
  const badge = $('[data-email-badge]');
  badge.textContent = info.verified ? 'Verified' : 'Not verified';
  badge.classList.toggle('badge--on', info.verified);
  badge.classList.toggle('badge--warn', !info.verified);
  $('[data-created]').textContent = `Created ${formatDate(info.createdAt)}`;
  $('[data-pending-email]').textContent = info.pendingEmail ?? '';
  $('[data-email-pending]').hidden = !info.pendingEmail;
}

account().then(({ account: info }) => show(info));

const changeDialog = $('[data-change-dialog]') as HTMLDialogElement;
const changeForm = $('[data-change-form]') as HTMLFormElement;
const newEmail = input(changeForm, 'email');

$('[data-change-email]').addEventListener('click', () => {
  changeForm.reset();
  clearErrors(changeForm);
  changeDialog.showModal();
  newEmail.focus();
});
$('[data-change-cancel]').addEventListener('click', () => changeDialog.close());

changeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(changeForm);
  const email = newEmail.value.trim();
  if (!email) return setFieldError(newEmail, 'Enter your new email.');
  try {
    const result = await busy(changeForm.querySelector('button[type=submit]'), () =>
      sensitive(() => api<{ pendingEmail: string }>('email/change', { body: { email } })),
    );
    if (!result) return;
    changeDialog.close();
    toast(`Link sent to ${result.pendingEmail}`);
    show((await account(true)).account);
  } catch (error) {
    showError(changeForm, error, 'email');
  }
});

$('[data-cancel-change]').addEventListener('click', async (event) => {
  try {
    await busy(event.currentTarget as HTMLButtonElement, () => api('email/change/cancel', { body: {} }));
    toast('Change cancelled');
    show((await account(true)).account);
  } catch (error) {
    reportError(error);
  }
});

$('[data-delete]').addEventListener('click', async (event) => {
  if (!(await confirmAction('Delete your account?', 'Your shared sessions, passkeys, and CLI tokens are deleted, and every shared link stops working.', 'Delete account'))) {
    return;
  }
  try {
    const result = await busy(event.currentTarget as HTMLButtonElement, () => sensitive(() => api('delete', { body: {} })));
    if (result) location.assign('/account/sign-in/?deleted=1');
  } catch (error) {
    reportError(error);
  }
});
