/**
 * Shared by the signed-in pages: the account summary, sign out, confirm-it's-you (re-authentication),
 * confirm dialogs, and the result of a trip to GitHub (?github= or ?github_error=).
 */

import { api, ApiError, loadMe, type Me } from './api';
import { githubErrorMessage, goToGitHub, takeParam } from './github';
import { passkeysSupported, usePasskey } from './passkey';
import { $, busy, clearErrors, input, setFieldError, showError, toast } from './ui';

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

const GITHUB_RESULTS: Record<string, string> = { connected: 'GitHub connected', confirmed: 'Confirmed. Try again to continue.' };
const githubResult = takeParam('github');
const githubError = takeParam('github_error');
if (githubResult && GITHUB_RESULTS[githubResult]) toast(GITHUB_RESULTS[githubResult]);
if (githubError) toast(githubErrorMessage(githubError));

const reauthDialog = $('[data-reauth]') as HTMLDialogElement;
const reauthForm = $('[data-reauth-form]') as HTMLFormElement;
const reauthPasskey = $('[data-reauth-passkey]') as HTMLButtonElement;
const reauthGitHub = $('[data-reauth-github]') as HTMLButtonElement;
const reauthSubmit = $('[data-reauth-submit]') as HTMLButtonElement;

/**
 * Opens "Confirm it's you". Resolves true once the password or a passkey is confirmed. GitHub leaves the
 * page and comes back to it with ?github=confirmed. An account made with GitHub has no password until its
 * owner sets one, so its main button is "Use GitHub".
 */
async function confirmIdentity(): Promise<boolean> {
  const { account: info } = await account();
  return new Promise<boolean>((resolve) => {
    clearErrors(reauthForm);
    reauthForm.reset();
    const withPassword = info.password;
    const password = input(reauthForm, 'password');
    $('[data-reauth-password]').hidden = !withPassword;
    reauthPasskey.hidden = info.passkeys === 0 || !passkeysSupported();
    reauthGitHub.hidden = !withPassword || !info.github;
    reauthSubmit.hidden = !withPassword && !info.github;
    reauthSubmit.textContent = withPassword ? 'Confirm' : 'Use GitHub';
    $('[data-reauth-text]').textContent = withPassword ? 'Enter your password to continue.' : info.github ? 'Use GitHub to continue.' : 'Use a passkey to continue.';
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      reauthForm.removeEventListener('submit', onSubmit);
      reauthPasskey.removeEventListener('click', onPasskey);
      reauthGitHub.removeEventListener('click', onGitHub);
      reauthDialog.removeEventListener('close', onClose);
      if (reauthDialog.open) reauthDialog.close();
      resolve(value);
    };
    const fail = (error: unknown) => (withPassword ? setFieldError(password, (error as Error).message) : showError(reauthForm, error));
    const onGitHub = async () => {
      clearErrors(reauthForm);
      try {
        await busy(withPassword ? reauthGitHub : reauthSubmit, () => goToGitHub('reauth', location.pathname + location.search));
      } catch (error) {
        fail(error);
      }
    };
    const onSubmit = async (event: SubmitEvent) => {
      event.preventDefault();
      if (!withPassword) return onGitHub();
      clearErrors(reauthForm);
      if (!password.value) return setFieldError(password, 'Enter your password.');
      try {
        await busy(reauthSubmit, () => api('reauth', { body: { password: password.value } }));
        finish(true);
      } catch (error) {
        fail(error);
      }
    };
    const onPasskey = async () => {
      clearErrors(reauthForm);
      try {
        await busy(reauthPasskey, () => usePasskey('reauth/passkey/options', 'reauth/passkey'));
        finish(true);
      } catch (error) {
        fail(error);
      }
    };
    const onClose = () => finish(false);
    reauthForm.addEventListener('submit', onSubmit);
    reauthPasskey.addEventListener('click', onPasskey);
    reauthGitHub.addEventListener('click', onGitHub);
    reauthDialog.addEventListener('close', onClose);
    $('[data-reauth-cancel]').onclick = () => finish(false);
    reauthDialog.showModal();
    (withPassword ? password : reauthSubmit.hidden ? reauthPasskey : reauthSubmit).focus();
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
