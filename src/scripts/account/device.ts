/** /device: approve or deny a pi CLI sign-in (RFC 8628). The Worker sends signed-out visitors to sign-in first. */

import { api, ApiError, loadMe } from './api';
import { $, busy, clearErrors, input, relativeTime, setFieldError, showStep, toast } from './ui';

interface DeviceRequest {
  userCode: string;
  client: string;
  createdAt: string;
  expiresAt: string;
}

const codeForm = $('[data-code-form]') as HTMLFormElement;
const codeInput = input(codeForm, 'user_code');
const decideError = $('[data-decide-error]');
let current: DeviceRequest | undefined;

/** Accepts "bcdfghjk", "BCDF GHJK", and "BCDF-GHJK"; shows it as BCDF-GHJK. */
function formatCode(value: string): string {
  const clean = value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

codeInput.addEventListener('input', () => {
  const formatted = formatCode(codeInput.value);
  if (formatted !== codeInput.value) codeInput.value = formatted;
});

async function lookUp(code: string): Promise<void> {
  const { request } = await api<{ request: DeviceRequest }>(`device?user_code=${encodeURIComponent(code)}`);
  current = request;
  $('[data-code-shown]').textContent = request.userCode;
  $('[data-client]').textContent = request.client;
  $('[data-requested]').textContent = relativeTime(request.createdAt);
  const url = new URL(location.href);
  url.searchParams.set('user_code', request.userCode);
  history.replaceState(null, '', url);
  decideError.hidden = true;
  showStep('confirm');
}

codeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(codeForm);
  const code = formatCode(codeInput.value);
  if (code.length !== 9) return setFieldError(codeInput, 'Enter the 8-letter code from your terminal.');
  try {
    await busy(codeForm.querySelector('button[type=submit]'), () => lookUp(code));
  } catch (error) {
    setFieldError(codeInput, (error as Error).message);
  }
});

async function decide(action: 'approve' | 'deny', button: HTMLButtonElement): Promise<void> {
  if (!current) return;
  decideError.hidden = true;
  try {
    await busy(button, () => api(`device/${action}`, { body: { user_code: current!.userCode } }));
    showStep(action === 'approve' ? 'approved' : 'denied');
  } catch (error) {
    decideError.textContent = (error as Error).message;
    decideError.hidden = false;
  }
}

$('[data-approve]').addEventListener('click', (event) => decide('approve', event.currentTarget as HTMLButtonElement));
$('[data-deny]').addEventListener('click', (event) => decide('deny', event.currentTarget as HTMLButtonElement));

$('[data-resend]').addEventListener('click', async (event) => {
  try {
    await busy(event.currentTarget as HTMLButtonElement, () => api('verify/resend', { body: {} }));
    toast('Link sent. Check your email.');
  } catch (error) {
    toast((error as Error).message);
  }
});

async function start(): Promise<void> {
  const { account } = await loadMe();
  $('[data-account]').textContent = account.email;
  if (!account.verified) {
    $('[data-unverified-email]').textContent = account.email;
    showStep('unverified');
    return;
  }
  const code = formatCode(new URLSearchParams(location.search).get('user_code') ?? '');
  if (code.length !== 9) {
    showStep('enter');
    return;
  }
  codeInput.value = code;
  try {
    await lookUp(code);
  } catch (error) {
    showStep('enter');
    if (error instanceof ApiError) setFieldError(codeInput, error.message);
  }
}

start().catch(() => showStep('enter'));
