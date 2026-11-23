/**
 * Sign-in: email, then password, then the second step when the account has one. Or GitHub, which comes back
 * here for the second step (?two_step=), to connect GitHub once the owner of its email signs in (?github=link),
 * or with an error (?github_error=). Or a passkey alone.
 */

import { api, ApiError, nextPath } from './api';
import { githubErrorMessage, goToGitHub, takeParam } from './github';
import { passkeysSupported, usePasskey } from './passkey';
import { $, busy, clearErrors, input, setFieldError, showError, showStep } from './ui';

type Methods = { totp: boolean; passkey: boolean; recovery: boolean };

const emailForm = $('[data-email-form]') as HTMLFormElement;
const passwordForm = $('[data-password-form]') as HTMLFormElement;
const totpForm = $('[data-totp-form]') as HTMLFormElement;
const recoveryForm = $('[data-recovery-form]') as HTMLFormElement;
let methods: Methods = { totp: false, passkey: false, recovery: false };
/** The first step was GitHub, so there is no password step to go back to. */
let viaGitHub = false;
/** GitHub came back with the email of this account, and is connected once the sign-in is done. */
let linking = false;

const params = new URLSearchParams(location.search);
const NOTICES: Record<string, string> = {
  deleted: 'Your account was deleted.',
  reset: 'Your password was changed. Sign in with the new password.',
  signedout: 'You signed out.',
};
const notice = $('[data-notice]');
for (const [key, text] of Object.entries(NOTICES)) {
  if (params.has(key)) {
    notice.textContent = text;
    notice.hidden = false;
  }
}

// Keep ?next= when switching to sign-up, so a device sign-in comes back here.
for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-keep-next]')) {
  if (params.has('next')) link.search = `?next=${encodeURIComponent(nextPath())}`;
}

async function done(): Promise<void> {
  const next = new URL(nextPath(), location.origin);
  if (linking) {
    try {
      await api('github/link', { body: {} });
    } catch (error) {
      location.assign(`/account/security/?github_error=${error instanceof ApiError && error.code === 'github_taken' ? 'taken' : 'not_linked'}`);
      return;
    }
    if (next.pathname.startsWith('/account/')) next.searchParams.set('github', 'connected');
  }
  location.assign(next.pathname + next.search);
}

emailForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors(emailForm);
  const email = input(emailForm, 'email');
  const value = email.value.trim();
  if (!value) return setFieldError(email, 'Enter your email.');
  if (!email.checkValidity() || !value.includes('.')) return setFieldError(email, 'Enter a valid email address.');
  $('[data-email-chip]').textContent = value;
  input(passwordForm, 'username').value = value;
  showStep('password');
});

$('[data-back-to-email]').addEventListener('click', () => {
  clearErrors(passwordForm);
  input(passwordForm, 'password').value = '';
  showStep('email');
});

$('[data-show-password]').addEventListener('change', (event) => {
  input(passwordForm, 'password').type = (event.target as HTMLInputElement).checked ? 'text' : 'password';
});

function secondStep(first: keyof Methods): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-choose]')) {
    button.hidden = !methods[button.dataset.choose as keyof Methods] || (button.dataset.choose === 'passkey' && !passkeysSupported());
  }
  showStep(first);
}

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(passwordForm);
  const password = input(passwordForm, 'password');
  if (!password.value) return setFieldError(password, 'Enter your password.');
  const button = passwordForm.querySelector<HTMLButtonElement>('button[type=submit]');
  try {
    const result = await busy(button, () =>
      api<{ next: string; methods?: Methods }>('sign-in', { body: { email: input(emailForm, 'email').value.trim(), password: password.value } }),
    );
    if (result.next === 'done') return done();
    methods = result.methods ?? methods;
    secondStep(methods.totp ? 'totp' : methods.passkey && passkeysSupported() ? 'passkey' : 'recovery');
  } catch (error) {
    showError(passwordForm, error, 'password');
  }
});

/** A second step that expired goes back to the password, or after GitHub, to the start. */
function restartIfExpired(error: unknown): boolean {
  if (!(error instanceof ApiError && error.code === 'sign_in_expired')) return false;
  if (viaGitHub) {
    showStep('email');
    showOtherError(error.message);
  } else {
    showStep('password');
    showError(passwordForm, error, 'password');
  }
  return true;
}

for (const [form, path] of [
  [totpForm, 'sign-in/totp'],
  [recoveryForm, 'sign-in/recovery'],
] as const) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);
    const code = input(form, 'code');
    if (!code.value.trim()) return setFieldError(code, 'Enter the code.');
    try {
      await busy(form.querySelector('button[type=submit]'), () => api(path, { body: { code: code.value.trim() } }));
      done();
    } catch (error) {
      if (!restartIfExpired(error)) showError(form, error, 'code');
    }
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-other-way]')) {
  button.addEventListener('click', () => showStep('choose'));
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-choose]')) {
  button.addEventListener('click', () => showStep(button.dataset.choose ?? 'totp'));
}

const secondPasskeyError = $('[data-second-passkey-error]');
$('[data-second-passkey]').addEventListener('click', async (event) => {
  secondPasskeyError.hidden = true;
  try {
    await busy(event.currentTarget as HTMLButtonElement, () => usePasskey('sign-in/passkey/options', 'sign-in/passkey', { secondStep: true }));
    done();
  } catch (error) {
    if (restartIfExpired(error)) return;
    secondPasskeyError.textContent = (error as Error).message;
    secondPasskeyError.hidden = false;
  }
});

const otherError = $('[data-other-error]');

function showOtherError(message: string): void {
  otherError.textContent = message;
  otherError.hidden = false;
}

$('[data-github-start]').addEventListener('click', async (event) => {
  otherError.hidden = true;
  try {
    await busy(event.currentTarget as HTMLButtonElement, () => goToGitHub('sign-in', nextPath()));
  } catch (error) {
    showOtherError((error as Error).message);
  }
});

const passkeyButton = $('[data-passkey-sign-in]') as HTMLButtonElement;
if (!passkeysSupported()) passkeyButton.hidden = true;
passkeyButton.addEventListener('click', async () => {
  otherError.hidden = true;
  try {
    await busy(passkeyButton, () => usePasskey('sign-in/passkey/options', 'sign-in/passkey'));
    done();
  } catch (error) {
    showOtherError((error as Error).message);
  }
});

const githubError = takeParam('github_error');
if (githubError) showOtherError(githubErrorMessage(githubError));

if (params.get('github') === 'link') {
  const githubButton = $('[data-github-start]');
  linking = true;
  githubButton.hidden = true;
  api<{ login: string; email: string }>('github/link').then(
    ({ login, email }) => {
      notice.textContent = `${email} already has an account. Sign in to connect the GitHub account ${login} to it.`;
      notice.hidden = false;
      input(emailForm, 'email').value = email;
    },
    (error: Error) => {
      linking = false;
      githubButton.hidden = false;
      showOtherError(error.message);
    },
  );
}

const twoStep = takeParam('two_step');
if (twoStep !== null) {
  const available = twoStep.split(',');
  methods = { totp: available.includes('totp'), passkey: available.includes('passkey'), recovery: available.includes('recovery') };
  viaGitHub = true;
  secondStep(methods.totp ? 'totp' : methods.passkey && passkeysSupported() ? 'passkey' : 'recovery');
}
