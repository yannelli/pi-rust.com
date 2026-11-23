/**
 * Shared by the signed-in pages: the account summary, sign out, confirm-it's-you (re-authentication),
 * and confirm dialogs.
 */

import { api, ApiError, loadMe, type Me } from './api';
import { passkeysSupported, usePasskey } from './passkey';
import { $, busy, clearErrors, input, setFieldError, toast } from './ui';

let me: Promise<Me> | undefined;

/** The account summary; pass `fresh` after a change. */
export function account(fresh = false): Promise<Me> {
  if (fresh || !me) me = loadMe();
  return me;
}

account().then(({ account }) => {
  $('[data-account-email]').textContent = account.email;
  const adminLink = document.querySelector<HTMLElement>('[data-admin-link]');
  if (adminLink) adminLink.hidden = !account.admin;
});

$('[data-sign-out]').addEventListener('click', async (event) => {
  try {
    await busy(event.currentTarget as HTMLButtonElement, () => api('sign-out', { body: {} }));
  } finally {
    location.assign('/account/sign-in/?signedout=1');
  }
});

const reauthDialog = $('[data-reauth]') as HTMLDialogElement;
const reauthForm = $('[data-reauth-form]') as HTMLFormElement;
const reauthPasskey = $('[data-reauth-passkey]') as HTMLButtonElement;

/** Opens "Confirm it's you". Resolves true once the password or a passkey is confirmed. */
function confirmIdentity(): Promise<boolean> {
  return new Promise((resolve) => {
    clearErrors(reauthForm);
    reauthForm.reset();
    account().then(({ account }) => (reauthPasskey.hidden = account.passkeys === 0 || !passkeysSupported()));
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      reauthForm.removeEventListener('submit', onSubmit);
      reauthPasskey.removeEventListener('click', onPasskey);
      reauthDialog.removeEventListener('close', onClose);
      if (reauthDialog.open) reauthDialog.close();
      resolve(value);
    };
    const onSubmit = async (event: SubmitEvent) => {
      event.preventDefault();
      clearErrors(reauthForm);
      const password = input(reauthForm, 'password');
      if (!password.value) return setFieldError(password, 'Enter your password.');
      try {
        await busy(reauthForm.querySelector('button[type=submit]'), () => api('reauth', { body: { password: password.value } }));
        finish(true);
      } catch (error) {
        setFieldError(password, (error as Error).message);
      }
    };
    const onPasskey = async () => {
      clearErrors(reauthForm);
      try {
        await busy(reauthPasskey, () => usePasskey('reauth/passkey/options', 'reauth/passkey'));
        finish(true);
      } catch (error) {
        setFieldError(input(reauthForm, 'password'), (error as Error).message);
      }
    };
    const onClose = () => finish(false);
    reauthForm.addEventListener('submit', onSubmit);
    reauthPasskey.addEventListener('click', onPasskey);
    reauthDialog.addEventListener('close', onClose);
    $('[data-reauth-cancel]').onclick = () => finish(false);
    reauthDialog.showModal();
    input(reauthForm, 'password').focus();
  });
}

/**
 * Runs a sensitive action. When the server asks for a fresh confirmation, asks for it and runs the
 * action again. Resolves undefined when the user cancels.
 */
export async function sensitive<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'reauth_required') throw error;
    if (!(await confirmIdentity())) return undefined;
    return work();
  }
}

const confirmDialog = $('[data-confirm]') as HTMLDialogElement;

/** Asks before a destructive action, or with `danger` false, before another important one. */
export function confirmAction(title: string, text: string, action: string, danger = true): Promise<boolean> {
  $('[data-confirm-title]').textContent = title;
  $('[data-confirm-text]').textContent = text;
  const button = $('[data-confirm-button]');
  button.textContent = action;
  button.className = danger ? 'btn btn--danger-solid' : 'btn btn--primary';
  confirmDialog.returnValue = '';
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'confirm'), { once: true });
  });
}

/** Shows an error from an action that has no form field. */
export function reportError(error: unknown): void {
  toast(error instanceof Error ? error.message : 'Something went wrong. Try again.');
}
