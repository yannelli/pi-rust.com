/** Password reset, first half: ask for a link by email. */

import { api } from './api';
import { $, busy, clearErrors, input, setFieldError, showError, showStep } from './ui';

const requestForm = $('[data-request-form]') as HTMLFormElement;

requestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(requestForm);
  const email = input(requestForm, 'email');
  const value = email.value.trim();
  if (!value) return setFieldError(email, 'Enter your email.');
  if (!email.checkValidity() || !value.includes('.')) return setFieldError(email, 'Enter a valid email address.');
  try {
    await busy(requestForm.querySelector('button[type=submit]'), () => api('reset/request', { body: { email: value } }));
    $('[data-sent-to]').textContent = value;
    showStep('sent');
  } catch (error) {
    showError(requestForm, error, 'email');
  }
});
