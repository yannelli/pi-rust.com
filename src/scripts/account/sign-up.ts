/**
 * Sign-up: email, then password, then "check your email". The reply is the same for a taken address.
 * Or GitHub, which comes back here with ?github=1 for the Terms box, or with ?github_error=.
 */

import { api, nextPath } from './api';
import { githubErrorMessage, goToGitHub, takeParam } from './github';
import { $, busy, clearErrors, input, setFieldError, showError, showStep } from './ui';

const emailForm = $('[data-email-form]') as HTMLFormElement;
const passwordForm = $('[data-password-form]') as HTMLFormElement;
const githubForm = $('[data-github-form]') as HTMLFormElement;
const params = new URLSearchParams(location.search);

if (params.has('next')) {
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

const githubError = $('[data-github-error]');

function showGitHubError(message: string): void {
  githubError.textContent = message;
  githubError.hidden = false;
}

$('[data-github-start]').addEventListener('click', async (event) => {
  githubError.hidden = true;
  try {
    await busy(event.currentTarget as HTMLButtonElement, () => goToGitHub('sign-in', nextPath()));
  } catch (error) {
    showGitHubError((error as Error).message);
  }
});

const githubErrorCode = takeParam('github_error');
if (githubErrorCode) showGitHubError(githubErrorMessage(githubErrorCode));

if (params.get('github') === '1') {
  showStep('github');
  api<{ login: string; email: string }>('github/sign-up').then(
    ({ login, email }) => {
      $('[data-github-login]').textContent = login;
      $('[data-github-email]').textContent = email;
    },
    (error: Error) => {
      showStep('email');
      showGitHubError(error.message);
    },
  );
}

githubForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(githubForm);
  const terms = input(githubForm, 'acceptTerms');
  if (!terms.checked) return setFieldError(terms, 'Confirm that you are 18 or older and agree to the Terms of Service.');
  try {
    await busy(githubForm.querySelector('button[type=submit]'), () => api('github/sign-up', { body: { acceptTerms: true, termsVersion: githubForm.dataset.termsVersion } }));
    location.assign(nextPath());
  } catch (error) {
    showError(githubForm, error);
  }
});
