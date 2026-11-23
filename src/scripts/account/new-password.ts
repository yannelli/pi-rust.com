/** Password reset, second half: the link's #token= and a new password. */

import { api, ApiError } from './api';
import { $, busy, clearErrors, input, setFieldError, showError, showStep } from './ui';

const passwordForm = $('[data-password-form]') as HTMLFormElement;
const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
// Drop the token from the address bar and history once it is read.
history.replaceState(null, '', location.pathname);
if (!token) showStep('failed');

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
  try {
    await busy(passwordForm.querySelector('button[type=submit]'), () => api('reset', { body: { token, password: password.value } }));
    location.assign('/account/sign-in/?reset=1');
  } catch (error) {
    if (error instanceof ApiError && error.code === 'invalid_token') showStep('failed');
    else showError(passwordForm, error, 'password');
  }
});
