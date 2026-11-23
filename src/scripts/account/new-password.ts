/**
 * Password reset, second half: the link's #token= and a new password. A connected GitHub account is shown,
 * with a box to disconnect it in the same step.
 */

import { api, ApiError } from './api';
import { $, busy, clearErrors, formatDate, input, setFieldError, showError, showStep } from './ui';

const passwordForm = $('[data-password-form]') as HTMLFormElement;
const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
// Drop the token from the address bar and history once it is read.
history.replaceState(null, '', location.pathname);

function failed(error: unknown): boolean {
  if (!(error instanceof ApiError && error.code === 'invalid_token')) return false;
  showStep('failed');
  return true;
}

if (!token) {
  showStep('failed');
} else {
  api<{ github: { login: string; connectedAt: string } | null }>('reset/check', { body: { token } }).then(({ github }) => {
    if (!github) return;
    $('[data-github-hint]').textContent = `The GitHub account ${github.login}, connected ${formatDate(github.connectedAt)}, can still sign in to your account.`;
    $('[data-github-field]').hidden = false;
  }, failed);
}

$('[data-show-password]').addEventListener('change', (event) => {
  input(passwordForm, 'password').type = (event.target as HTMLInputElement).checked ? 'text' : 'password';
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(passwordForm);
  const password = input(passwordForm, 'password');
  const length = [...password.value].length;
  if (length < 10) return setFieldError(password, 'Use at least 10 characters.');
  if (length > 256) return setFieldError(password, 'Use at most 256 characters.');
  const disconnectGitHub = input(passwordForm, 'disconnectGitHub').checked;
  try {
    await busy(passwordForm.querySelector('button[type=submit]'), () => api('reset', { body: { token, password: password.value, disconnectGitHub } }));
    location.assign('/account/sign-in/?reset=1');
  } catch (error) {
    if (!failed(error)) showError(passwordForm, error, 'password');
  }
});
