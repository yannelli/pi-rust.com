/** Sign-up: email, then password, then "check your email". The reply is the same for a taken address. */

import { api, nextPath } from './api';
import { $, busy, clearErrors, input, setFieldError, showError, showStep } from './ui';

const emailForm = $('[data-email-form]') as HTMLFormElement;
const passwordForm = $('[data-password-form]') as HTMLFormElement;

if (new URLSearchParams(location.search).has('next')) {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-keep-next]')) link.search = `?next=${encodeURIComponent(nextPath())}`;
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

for (const button of document.querySelectorAll('[data-back-to-email]')) {
  button.addEventListener('click', () => {
    clearErrors(passwordForm);
    showStep('email');
  });
}

$('[data-show-password]').addEventListener('change', (event) => {
  input(passwordForm, 'password').type = (event.target as HTMLInputElement).checked ? 'text' : 'password';
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(passwordForm);
  const email = input(emailForm, 'email').value.trim();
  const password = input(passwordForm, 'password');
  const length = [...password.value].length;
  if (length < 10) return setFieldError(password, 'Use at least 10 characters.');
  if (length > 256) return setFieldError(password, 'Use at most 256 characters.');
  if (password.value.trim().toLowerCase() === email.toLowerCase()) return setFieldError(password, 'Don’t use your email address as your password.');
  const terms = input(passwordForm, 'acceptTerms');
  if (!terms.checked) return setFieldError(terms, 'Confirm that you are 18 or older and agree to the Terms of Service.');
  try {
    await busy(passwordForm.querySelector('button[type=submit]'), () => api('sign-up', { body: { email, password: password.value, acceptTerms: true, termsVersion: passwordForm.dataset.termsVersion } }));
    $('[data-sent-to]').textContent = email;
    showStep('sent');
  } catch (error) {
    if ((error as { field?: string }).field === 'email') {
      showStep('email');
      showError(emailForm, error, 'email');
    } else {
      showError(passwordForm, error, 'password');
    }
  }
});
