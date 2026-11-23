// Changing the email address: a recent confirmation, a link to the new address, a notice to the old one,
// an undo link that takes the account back, and the page on /account/settings/.

import { test, expect, type Page } from '@playwright/test';
import {
  accountClient,
  cliClient,
  cliToken,
  devState,
  linkIn,
  mailbox,
  pageIp,
  PASSWORD,
  testIp,
  tokenOf,
  totp,
  uniqueEmail,
  verifiedAccount,
  waitForMail,
} from './helpers/accounts';

// Each test runs in one browser project: the desktop one.
test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'runs once'));

test('a change needs a recent confirmation and the link sent to the new address', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const next = uniqueEmail('moved');

  await devState(client, { action: 'age-reauth', email });
  const stale = await client.post('/api/account/email/change', { data: { email: next } });
  expect(stale.status()).toBe(403);
  expect((await stale.json()).error).toBe('reauth_required');
  expect((await client.post('/api/account/reauth', { data: { password: PASSWORD } })).status()).toBe(200);

  const same = await client.post('/api/account/email/change', { data: { email: email.toUpperCase() } });
  expect(same.status()).toBe(400);
  expect(await same.json()).toMatchObject({ error: 'same_email', field: 'email' });
  expect((await (await client.post('/api/account/email/change', { data: { email: 'not an address' } })).json()).error).toBe('invalid_email');

  const change = await client.post('/api/account/email/change', { data: { email: next.toUpperCase() } });
  expect(await change.json()).toEqual({ ok: true, pendingEmail: next });
  expect((await (await client.get('/api/account/me')).json()).account).toMatchObject({ email, pendingEmail: next });
  const notice = await waitForMail(client, email, /^Your pi-rust email is about to change$/);
  expect(notice.text).toContain(next);
  const link = linkIn(await waitForMail(client, next, /^Confirm your new email for pi-rust$/), /\/account\/confirm-email\//);
  expect(link).toMatch(/\/account\/confirm-email\/#token=[A-Za-z0-9_-]{43}$/);

  // Nothing changes before the link is opened.
  const stranger = await accountClient(playwright, baseURL!);
  expect((await stranger.post('/api/account/sign-in', { data: { email: next, password: PASSWORD } })).status()).toBe(401);

  const confirm = await client.post('/api/account/email/confirm', { data: { token: tokenOf(link) } });
  expect(await confirm.json()).toEqual({ ok: true, email: next, signedIn: true });
  expect((await (await client.get('/api/account/me')).json()).account).toMatchObject({ email: next, verified: true, pendingEmail: null });
  const again = await client.post('/api/account/email/confirm', { data: { token: tokenOf(link) } });
  expect(again.status()).toBe(400);
  expect((await again.json()).error).toBe('invalid_token');

  expect((await stranger.post('/api/account/sign-in', { data: { email: next, password: PASSWORD } })).status()).toBe(200);
  expect((await (await accountClient(playwright, baseURL!)).post('/api/account/sign-in', { data: { email, password: PASSWORD } })).status()).toBe(401);
  const changed = await waitForMail(client, email, /^Your pi-rust email was changed$/);
  expect(changed.text).toContain(next);
  expect(linkIn(changed, /\/account\/undo-email\//)).toMatch(/#token=[A-Za-z0-9_-]{43}$/);
});

test('undo from the old address takes the account back from whoever moved it', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const next = uniqueEmail('taken-over');
  expect((await client.post('/api/account/email/change', { data: { email: next } })).status()).toBe(200);
  // Added after the change was asked for, as by someone who took over the account.
  const { secret } = await (await client.post('/api/account/totp/setup', { data: {} })).json();
  expect((await client.post('/api/account/totp/enable', { data: { code: totp(secret) } })).status()).toBe(200);
  const token = await cliToken(playwright, baseURL!, client);
  const link = linkIn(await waitForMail(client, next, /^Confirm your new email/), /\/account\/confirm-email\//);
  expect((await client.post('/api/account/email/confirm', { data: { token: tokenOf(link) } })).status()).toBe(200);

  const undoLink = linkIn(await waitForMail(client, email, /^Your pi-rust email was changed$/), /\/account\/undo-email\//);
  const owner = await accountClient(playwright, baseURL!);
  const undo = await owner.post('/api/account/email/undo', { data: { token: tokenOf(undoLink) } });
  expect(await undo.json()).toEqual({ ok: true, email });

  // Signed out everywhere, and the CLI token stops working.
  expect((await client.get('/api/account/me')).status()).toBe(401);
  expect((await (await cliClient(playwright, baseURL!, token)).get('/v1/account')).status()).toBe(401);
  // The password no longer works; the link sent to the old address sets a new one.
  expect((await owner.post('/api/account/sign-in', { data: { email, password: PASSWORD } })).status()).toBe(401);
  const reset = linkIn(await waitForMail(owner, email, /^The change of your pi-rust email was undone$/), /\/account\/new-password\//);
  const password = 'a brand new password 42';
  expect((await owner.post('/api/account/reset', { data: { token: tokenOf(reset), password } })).status()).toBe(200);
  // The two-step verification turned on since the request is gone, so a password signs in.
  expect(await (await owner.post('/api/account/sign-in', { data: { email, password } })).json()).toEqual({ ok: true, next: 'done' });
  expect((await (await owner.get('/api/account/me')).json()).account).toMatchObject({ email, totp: false, pendingEmail: null });
  expect((await owner.post('/api/account/email/undo', { data: { token: tokenOf(undoLink) } })).status()).toBe(400);
});

test('an address with an account gets a notice, and a cancel or a password reset ends a waiting change', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const { email: taken } = await verifiedAccount(playwright, baseURL!);

  // The answer is the same as for a free address; the address's owner gets a notice, not a link.
  expect(await (await client.post('/api/account/email/change', { data: { email: taken } })).json()).toEqual({ ok: true, pendingEmail: taken });
  await waitForMail(client, taken, /^Email change attempt for your pi-rust account$/);
  expect((await mailbox(client, taken)).some((mail) => /Confirm your new email/.test(mail.subject))).toBe(false);
  expect((await (await client.get('/api/account/me')).json()).account.pendingEmail).toBe(taken);
  expect((await client.post('/api/account/email/change/cancel', { data: {} })).status()).toBe(200);
  expect((await (await client.get('/api/account/me')).json()).account.pendingEmail).toBeNull();

  const next = uniqueEmail('pending');
  expect((await client.post('/api/account/email/change', { data: { email: next } })).status()).toBe(200);
  const link = linkIn(await waitForMail(client, next, /^Confirm your new email/), /\/account\/confirm-email\//);
  const helper = await accountClient(playwright, baseURL!, testIp());
  expect((await helper.post('/api/account/reset/request', { data: { email } })).status()).toBe(200);
  const reset = linkIn(await waitForMail(helper, email, /^Reset your pi-rust password$/), /\/account\/new-password\//);
  expect((await helper.post('/api/account/reset', { data: { token: tokenOf(reset), password: 'another new password 7' } })).status()).toBe(200);
  const confirm = await helper.post('/api/account/email/confirm', { data: { token: tokenOf(link) } });
  expect(confirm.status()).toBe(400);
  expect((await confirm.json()).error).toBe('invalid_token');
});

async function signInPage(page: Page, baseURL: string, email: string): Promise<void> {
  await pageIp(page.context());
  const response = await page.request.post('/api/account/sign-in', { headers: { Origin: baseURL, 'CF-Connecting-IP': testIp() }, data: { email, password: PASSWORD } });
  expect(response.status()).toBe(200);
}

test('change the email on the Account page', async ({ page, playwright, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const next = uniqueEmail('page');
  await signInPage(page, baseURL!, email);

  await page.goto('/account/settings/');
  await expect(page.locator('[data-email]')).toHaveText(email);
  await page.getByRole('button', { name: 'Change email' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change email' });
  await dialog.getByRole('button', { name: 'Send link' }).click();
  await expect(dialog.getByText('Enter your new email.')).toBeVisible();
  await dialog.getByLabel('New email').fill(email);
  await dialog.getByRole('button', { name: 'Send link' }).click();
  await expect(dialog.getByText('That is already your email address.')).toBeVisible();
  await dialog.getByLabel('New email').fill(next);
  await dialog.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Link sent to ${next}` })).toBeVisible();
  await expect(page.locator('[data-email-pending]')).toContainText(`Open the link sent to ${next}`);

  const link = linkIn(await waitForMail(client, next, /^Confirm your new email/), /\/account\/confirm-email\//);
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Email changed' })).toBeVisible();
  await expect(page.getByText(`You now sign in with ${next}.`)).toBeVisible();
  // The token is gone from the address bar.
  expect(page.url()).not.toContain('token');
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page.locator('[data-email]')).toHaveText(next);
  await expect(page.locator('[data-email-pending]')).toBeHidden();
  expect(errors).toEqual([]);
});
