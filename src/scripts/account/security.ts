/** Security: password, GitHub, two-step verification, recovery codes, passkeys, sessions, and CLI tokens. */

import { renderSVG } from 'uqr';
import { api } from './api';
import { goToGitHub } from './github';
import { account, confirmAction, reportError, sensitive } from './panel';
import { addPasskey, passkeysSupported } from './passkey';
import { $, busy, clearErrors, copyText, el, formatDate, input, relativeTime, setFieldError, showError, toast } from './ui';

// Password. An account made with GitHub has none until its owner sets one.
const passwordForm = $('[data-password-form]') as HTMLFormElement;
const passwordFoot = $('[data-password-foot]');

async function renderPassword(fresh = false): Promise<void> {
  const { account: info } = await account(fresh);
  $('[data-password-desc]').textContent = info.password
    ? 'Changing it signs you out of your other browser sessions.'
    : 'Your account has no password. Set one to also sign in with your email address.';
  $('[data-password-open]').textContent = info.password ? 'Change password' : 'Set password';
}

$('[data-password-open]').addEventListener('click', () => {
  passwordForm.hidden = false;
  passwordFoot.hidden = true;
  input(passwordForm, 'password').focus();
});

function closePasswordForm(): void {
  passwordForm.reset();
  clearErrors(passwordForm);
  passwordForm.hidden = true;
  passwordFoot.hidden = false;
}

$('[data-password-cancel]').addEventListener('click', closePasswordForm);

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(passwordForm);
  const password = input(passwordForm, 'password');
  const length = [...password.value].length;
  if (length < 10) return setFieldError(password, 'Use at least 10 characters.');
  if (length > 256) return setFieldError(password, 'Use at most 256 characters.');
  try {
    const result = await busy(passwordForm.querySelector('button[type=submit]'), () => sensitive(() => api('password', { body: { password: password.value } })));
    if (!result) return;
    closePasswordForm();
    toast('Password saved');
    renderPassword(true);
    loadSessions();
  } catch (error) {
    showError(passwordForm, error, 'password');
  }
});

// GitHub
const githubConnect = $('[data-github-connect]') as HTMLButtonElement;
const githubDisconnect = $('[data-github-disconnect]') as HTMLButtonElement;

async function renderGitHub(fresh = false): Promise<void> {
  const { github } = (await account(fresh)).account;
  const used = github?.lastUsedAt ? ` · Last used ${relativeTime(github.lastUsedAt)}` : '';
  $('[data-github-status]').textContent = github ? `Connected to ${github.login}${used}` : '';
  githubConnect.hidden = Boolean(github);
  githubDisconnect.hidden = !github;
}

githubConnect.addEventListener('click', async () => {
  try {
    await busy(githubConnect, () => sensitive(() => goToGitHub('connect')));
  } catch (error) {
    reportError(error);
  }
});

githubDisconnect.addEventListener('click', async () => {
  if (!(await confirmAction('Disconnect GitHub?', 'You can no longer sign in with this GitHub account.', 'Disconnect'))) return;
  try {
    const result = await busy(githubDisconnect, () => sensitive(() => api('github', { method: 'DELETE' })));
    if (!result) return;
    toast('GitHub disconnected');
    renderGitHub(true);
  } catch (error) {
    reportError(error);
  }
});

// Two-step verification and recovery codes
const totpSetup = $('[data-totp-setup]');
// Cancel and Verify sit in the section footer, like every other section's actions.
const totpActions = $('[data-totp-actions]');
const totpForm = $('[data-totp-form]') as HTMLFormElement;
const totpOn = $('[data-totp-on]') as HTMLButtonElement;
const totpOff = $('[data-totp-off]') as HTMLButtonElement;
const codesNew = $('[data-codes-new]');
let shownCodes: string[] = [];

async function renderTwoStep(fresh = false): Promise<void> {
  const { account: info } = await account(fresh);
  const badge = $('[data-totp-badge]');
  badge.textContent = info.totp ? 'On' : 'Off';
  badge.classList.toggle('badge--on', info.totp);
  $('[data-totp-status]').textContent = info.totp ? 'Your authenticator app is set up.' : '';
  totpOn.hidden = info.totp || !totpSetup.hidden;
  totpOff.hidden = !info.totp;
  const hasSecondStep = info.totp || info.passkeys > 0;
  $('[data-codes-status]').textContent = hasSecondStep
    ? `${info.recoveryCodes} of 10 codes left.`
    : 'You get recovery codes when you turn on two-step verification or add a passkey.';
  ($('[data-codes-regenerate]') as HTMLButtonElement).hidden = !hasSecondStep || !codesNew.hidden;
}

function showCodes(codes: string[]): void {
  shownCodes = codes;
  $('[data-codes-list]').replaceChildren(...codes.map((code) => el('li', {}, code)));
  codesNew.hidden = false;
  ($('[data-codes-regenerate]') as HTMLButtonElement).hidden = true;
  $('[data-codes-section]').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  ($('[data-codes-copy]') as HTMLButtonElement).focus({ preventScroll: true });
}

$('[data-codes-copy]').addEventListener('click', () => copyText(shownCodes.join('\n'), 'Codes copied'));
$('[data-codes-done]').addEventListener('click', () => {
  shownCodes = [];
  codesNew.hidden = true;
  $('[data-codes-list]').replaceChildren();
  renderTwoStep(true);
});

$('[data-codes-regenerate]').addEventListener('click', async (event) => {
  if (!(await confirmAction('Get new recovery codes?', 'Your current codes will stop working.', 'Get new codes'))) return;
  try {
    const result = await busy(event.currentTarget as HTMLButtonElement, () => sensitive(() => api<{ recoveryCodes: string[] }>('recovery-codes', { body: {} })));
    if (result) showCodes(result.recoveryCodes);
  } catch (error) {
    reportError(error);
  }
});

totpOn.addEventListener('click', async () => {
  try {
    const result = await busy(totpOn, () => sensitive(() => api<{ secret: string; uri: string }>('totp/setup', { body: {} })));
    if (!result) return;
    // The SVG is built here from the otpauth URI; no server text is parsed as HTML.
    $('[data-totp-qr]').innerHTML = renderSVG(result.uri, { border: 0 });
    $('[data-totp-secret]').textContent = result.secret.replace(/(.{4})/g, '$1 ').trim();
    totpSetup.hidden = false;
    totpActions.hidden = false;
    totpOn.hidden = true;
    input(totpForm, 'code').focus();
  } catch (error) {
    reportError(error);
  }
});

function closeTotpSetup(): void {
  totpForm.reset();
  clearErrors(totpForm);
  totpSetup.hidden = true;
  totpActions.hidden = true;
  $('[data-totp-qr]').replaceChildren();
  $('[data-totp-secret]').textContent = '';
}

$('[data-totp-cancel]').addEventListener('click', () => {
  closeTotpSetup();
  renderTwoStep();
});

totpForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(totpForm);
  const code = input(totpForm, 'code');
  if (!/^\d{6}$/.test(code.value.replace(/\s/g, ''))) return setFieldError(code, 'Enter the 6-digit code.');
  try {
    const result = await busy(totpActions.querySelector('button[type=submit]'), () =>
      sensitive(() => api<{ recoveryCodes: string[] }>('totp/enable', { body: { code: code.value.replace(/\s/g, '') } })),
    );
    if (!result) return;
    closeTotpSetup();
    await renderTwoStep(true);
    toast('Two-step verification is on');
    showCodes(result.recoveryCodes);
  } catch (error) {
    showError(totpForm, error, 'code');
  }
});

totpOff.addEventListener('click', async () => {
  if (!(await confirmAction('Turn off two-step verification?', 'Signing in will no longer ask for a code from your authenticator app.', 'Turn off'))) return;
  try {
    const result = await busy(totpOff, () => sensitive(() => api('totp/disable', { body: {} })));
    if (!result) return;
    toast('Two-step verification is off');
    await renderTwoStep(true);
  } catch (error) {
    reportError(error);
  }
});

// Passkeys
interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const passkeyList = $('[data-passkeys]');
const renameDialog = $('[data-rename]') as HTMLDialogElement;
const renameForm = $('[data-rename-form]') as HTMLFormElement;

function rename(passkey: Passkey): void {
  clearErrors(renameForm);
  const name = input(renameForm, 'name');
  name.value = passkey.name;
  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    clearErrors(renameForm);
    if (!name.value.trim()) return setFieldError(name, 'Enter a name.');
    try {
      await busy(renameForm.querySelector('button[type=submit]'), () => api(`passkeys/${passkey.id}`, { method: 'PATCH', body: { name: name.value.trim() } }));
      renameDialog.close();
      toast('Passkey renamed');
      loadPasskeys();
    } catch (error) {
      showError(renameForm, error, 'name');
    }
  };
  renameForm.addEventListener('submit', onSubmit);
  renameDialog.addEventListener('close', () => renameForm.removeEventListener('submit', onSubmit), { once: true });
  $('[data-rename-cancel]').onclick = () => renameDialog.close();
  renameDialog.showModal();
  name.select();
}

function passkeyRow(passkey: Passkey): HTMLLIElement {
  const renameButton = el('button', { type: 'button', className: 'btn btn--secondary btn--small' }, 'Rename');
  renameButton.setAttribute('aria-label', `Rename ${passkey.name}`);
  renameButton.addEventListener('click', () => rename(passkey));
  const remove = el('button', { type: 'button', className: 'btn btn--danger btn--small' }, 'Remove');
  remove.setAttribute('aria-label', `Remove ${passkey.name}`);
  remove.addEventListener('click', async () => {
    if (!(await confirmAction('Remove passkey?', `You won’t be able to sign in with “${passkey.name}”.`, 'Remove'))) return;
    try {
      const result = await busy(remove, () => sensitive(() => api(`passkeys/${passkey.id}`, { method: 'DELETE' })));
      if (!result) return;
      toast('Passkey removed');
      await Promise.all([loadPasskeys(), renderTwoStep(true)]);
    } catch (error) {
      reportError(error);
    }
  });
  const used = passkey.lastUsedAt ? `Last used ${relativeTime(passkey.lastUsedAt)}` : 'Not used yet';
  return el(
    'li',
    {},
    el('div', { className: 'list__text' }, el('span', { className: 'list__title' }, passkey.name), el('span', { className: 'list__meta' }, `Added ${formatDate(passkey.createdAt)} · ${used}`)),
    el('div', { className: 'list__actions' }, renameButton, remove),
  );
}

async function loadPasskeys(): Promise<void> {
  try {
    const { passkeys } = await api<{ passkeys: Passkey[] }>('passkeys');
    passkeyList.replaceChildren(...(passkeys.length ? passkeys.map(passkeyRow) : [el('li', { className: 'list__empty' }, 'No passkeys.')]));
  } catch (error) {
    passkeyList.replaceChildren(el('li', { className: 'list__empty' }, (error as Error).message));
  } finally {
    passkeyList.removeAttribute('aria-busy');
  }
}

const addButton = $('[data-passkey-add]') as HTMLButtonElement;
if (!passkeysSupported()) {
  addButton.hidden = true;
  $('[data-passkey-support]').textContent = 'This browser does not support passkeys.';
}
addButton.addEventListener('click', async () => {
  try {
    const result = await busy(addButton, () => sensitive(() => addPasskey()));
    if (!result) return;
    toast('Passkey added');
    await Promise.all([loadPasskeys(), renderTwoStep(true)]);
    if (result.recoveryCodes) showCodes(result.recoveryCodes);
  } catch (error) {
    reportError(error);
  }
});

// Browser sessions
interface SessionInfo {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

const sessionList = $('[data-sessions]');

function sessionRow(session: SessionInfo): HTMLLIElement {
  const end = el('button', { type: 'button', className: 'btn btn--secondary btn--small' }, 'Sign out');
  end.setAttribute('aria-label', session.current ? 'Sign out of this browser' : `Sign out of ${session.label}`);
  end.addEventListener('click', async () => {
    try {
      const result = await busy(end, () => api<{ signedOut: boolean }>(`sessions/${session.id}`, { method: 'DELETE' }));
      if (result.signedOut) location.assign('/account/sign-in/?signedout=1');
      else loadSessions();
    } catch (error) {
      reportError(error);
    }
  });
  const title = el('span', { className: 'list__title' }, session.label);
  if (session.current) title.append(' ', el('span', { className: 'badge' }, 'This browser'));
  return el(
    'li',
    {},
    el('div', { className: 'list__text' }, title, el('span', { className: 'list__meta' }, `Signed in ${formatDate(session.createdAt)} · Active ${relativeTime(session.lastSeenAt)}`)),
    el('div', { className: 'list__actions' }, end),
  );
}

async function loadSessions(): Promise<void> {
  try {
    const { sessions } = await api<{ sessions: SessionInfo[] }>('sessions');
    sessionList.replaceChildren(...sessions.map(sessionRow));
  } catch (error) {
    sessionList.replaceChildren(el('li', { className: 'list__empty' }, (error as Error).message));
  } finally {
    sessionList.removeAttribute('aria-busy');
  }
}

$('[data-sessions-others]').addEventListener('click', async (event) => {
  if (!(await confirmAction('Sign out of other sessions?', 'Every other browser signed in to your account will be signed out.', 'Sign out'))) return;
  try {
    const result = await busy(event.currentTarget as HTMLButtonElement, () => sensitive(() => api<{ revoked: number }>('sessions/revoke-others', { body: {} })));
    if (!result) return;
    toast(result.revoked === 1 ? 'Signed out of 1 session' : `Signed out of ${result.revoked} sessions`);
    loadSessions();
  } catch (error) {
    reportError(error);
  }
});

// CLI tokens
interface Token {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const tokenList = $('[data-tokens]');

function tokenRow(token: Token): HTMLLIElement {
  const revoke = el('button', { type: 'button', className: 'btn btn--danger btn--small' }, 'Revoke');
  revoke.setAttribute('aria-label', `Revoke ${token.name} token from ${formatDate(token.createdAt)}`);
  revoke.addEventListener('click', async () => {
    if (!(await confirmAction('Revoke token?', 'The pi CLI that uses it will be signed out.', 'Revoke'))) return;
    try {
      await busy(revoke, () => api(`tokens/${token.id}`, { method: 'DELETE' }));
      toast('Token revoked');
      loadTokens();
    } catch (error) {
      reportError(error);
    }
  });
  const used = token.lastUsedAt ? `Last used ${relativeTime(token.lastUsedAt)}` : 'Not used yet';
  return el(
    'li',
    {},
    el('div', { className: 'list__text' }, el('span', { className: 'list__title' }, token.name), el('span', { className: 'list__meta' }, `Created ${formatDate(token.createdAt)} · ${used}`)),
    el('div', { className: 'list__actions' }, revoke),
  );
}

async function loadTokens(): Promise<void> {
  try {
    const { tokens } = await api<{ tokens: Token[] }>('tokens');
    tokenList.replaceChildren(...(tokens.length ? tokens.map(tokenRow) : [el('li', { className: 'list__empty' }, 'No CLI tokens.')]));
  } catch (error) {
    tokenList.replaceChildren(el('li', { className: 'list__empty' }, (error as Error).message));
  } finally {
    tokenList.removeAttribute('aria-busy');
  }
}

renderPassword();
renderGitHub();
renderTwoStep();
loadPasskeys();
loadSessions();
loadTokens();
