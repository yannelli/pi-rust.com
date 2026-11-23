// Sign in with GitHub, against the fake GitHub that the Worker uses in local tests (worker/accounts/dev.ts):
// sign-up with the Terms box, sign-in with the second step, connecting, confirming it's you, and disconnecting.

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  accountClient,
  approveOnGitHub,
  createVerified,
  devState,
  githubAccount,
  githubTrip,
  linkIn,
  mailbox,
  pageIp,
  PASSWORD,
  TERMS,
  tokenOf,
  totp,
  uniqueEmail,
  verifiedAccount,
  waitForMail,
  type FakeGitHubAccount,
} from './helpers/accounts';

const NEW_PASSWORD = 'a brand new password 42';

// Each test runs in one browser project: the desktop one.
test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'runs once'));

test('a new GitHub account signs up after the Terms box, then signs in with GitHub', async ({ playwright, baseURL }) => {
  const client = await accountClient(playwright, baseURL!);
  const github = githubAccount('new');
  const location = new URL(await githubTrip(client, 'sign-in', github, '/device/?user_code=BCDF-GHJK'), baseURL);
  expect(location.pathname).toBe('/account/sign-up/');
  expect(Object.fromEntries(location.searchParams)).toEqual({ github: '1', next: '/device/?user_code=BCDF-GHJK' });
  expect((await client.get('/api/account/me')).status()).toBe(401);
  expect(await (await client.get('/api/account/github/sign-up')).json()).toEqual({ ok: true, login: github.login, email: github.email });

  const unchecked = await client.post('/api/account/github/sign-up', { data: {} });
  expect(unchecked.status()).toBe(400);
  expect((await unchecked.json()).error).toBe('terms_required');
  expect(await (await client.post('/api/account/github/sign-up', { data: TERMS })).json()).toEqual({ ok: true, next: 'done' });
  expect((await (await client.get('/api/account/me')).json()).account).toMatchObject({ email: github.email, verified: true, password: false, github: { login: github.login } });
  expect((await client.post('/api/account/github/sign-up', { data: TERMS })).status()).toBe(401);

  // The account has no password, so no password signs in, not even an empty one.
  const browser = await accountClient(playwright, baseURL!);
  for (const password of ['', PASSWORD]) {
    expect((await browser.post('/api/account/sign-in', { data: { email: github.email, password } })).status()).toBe(401);
  }
  // The GitHub user ID signs in; the username is updated when it changes.
  expect(await githubTrip(browser, 'sign-in', { ...github, login: `renamed-${github.login}` })).toBe('/account/');
  expect((await (await browser.get('/api/account/me')).json()).account.github.login).toBe(`renamed-${github.login}`);
});

test('GitHub with the email of an account connects to it only once its owner signs in', async ({ playwright, baseURL }) => {
  const { email } = await verifiedAccount(playwright, baseURL!);
  const github = { ...githubAccount('link'), email: email.toUpperCase() };
  const client = await accountClient(playwright, baseURL!);
  expect(await githubTrip(client, 'sign-in', github, '/account/settings/')).toBe('/account/sign-in/?github=link&next=%2Faccount%2Fsettings%2F');
  expect((await client.get('/api/account/me')).status()).toBe(401);
  expect(await (await client.get('/api/account/github/link')).json()).toEqual({ ok: true, login: github.login, email });
  expect((await client.post('/api/account/github/link', { data: {} })).status()).toBe(401);

  // Signing in to another account does not connect GitHub to it.
  const other = uniqueEmail('other');
  await createVerified(client, other);
  expect((await client.post('/api/account/sign-in', { data: { email: other, password: PASSWORD } })).status()).toBe(200);
  expect((await (await client.post('/api/account/github/link', { data: {} })).json()).error).toBe('other_account');

  expect((await client.post('/api/account/sign-in', { data: { email, password: PASSWORD } })).status()).toBe(200);
  expect(await (await client.post('/api/account/github/link', { data: {} })).json()).toEqual({ ok: true });
  expect((await (await client.get('/api/account/me')).json()).account.github.login).toBe(github.login);
  expect((await waitForMail(client, email, /^GitHub was connected to your pi-rust account$/)).text).toContain(github.login);
  expect((await client.post('/api/account/github/link', { data: {} })).status()).toBe(401);
  expect(await githubTrip(await accountClient(playwright, baseURL!), 'sign-in', github)).toBe('/account/');

  // Another GitHub account with the same email cannot take its place, and an unverified email gets nothing.
  const stranger = await accountClient(playwright, baseURL!);
  expect(await githubTrip(stranger, 'sign-in', { ...githubAccount('second'), email })).toBe('/account/sign-in/?github_error=email_taken');
  expect(await githubTrip(stranger, 'sign-in', { ...githubAccount('unverified'), verified: false })).toBe('/account/sign-in/?github_error=no_email');
  expect((await stranger.get('/api/account/me')).status()).toBe(401);
});

/** Asks for a reset link and returns its token, once the new email is in the dev mailbox. */
async function resetToken(client: APIRequestContext, email: string): Promise<string> {
  const resets = async () => (await mailbox(client, email)).filter((mail) => /^Reset your pi-rust password$/.test(mail.subject));
  const before = (await resets()).length;
  expect((await client.post('/api/account/reset/request', { data: { email } })).status()).toBe(200);
  await expect.poll(async () => (await resets()).length).toBe(before + 1);
  return tokenOf(linkIn((await resets())[0], /\/account\/new-password\//));
}

test('a password reset keeps GitHub, says so, and ends GitHub sign-ins in progress', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const github = githubAccount('reset');
  expect(await githubTrip(client, 'connect', github)).toBe('/account/security/?github=connected');
  const reauth = await client.post('/api/account/github/start', { data: { intent: 'reauth', next: '/account/security/' } });

  const anyone = await accountClient(playwright, baseURL!);
  const token = await resetToken(anyone, email);
  expect(await (await anyone.post('/api/account/reset/check', { data: { token } })).json()).toEqual({ ok: true, github: { login: github.login, connectedAt: expect.any(String) } });
  expect((await anyone.post('/api/account/reset', { data: { token, password: NEW_PASSWORD } })).status()).toBe(200);
  expect((await anyone.post('/api/account/reset/check', { data: { token } })).status()).toBe(400);

  const changed = await waitForMail(anyone, email, /^Your pi-rust password was changed$/);
  expect(changed.text).toContain(`The GitHub account ${github.login} can still sign in to your account.`);
  // The GitHub confirmation started before the reset no longer works; GitHub sign-in still does.
  const back = await client.get(await approveOnGitHub(client, (await reauth.json()).url, github), { maxRedirects: 0 });
  expect(back.headers().location).toBe('/account/sign-in/?github_error=expired');
  expect(await githubTrip(await accountClient(playwright, baseURL!), 'sign-in', github)).toBe('/account/');
});

test('connecting needs a recent confirmation, and a GitHub account connects to one pi-rust account', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const github = githubAccount('connect');
  await devState(client, { action: 'age-reauth', email });
  const stale = await client.post('/api/account/github/start', { data: { intent: 'connect' } });
  expect(stale.status()).toBe(403);
  expect((await stale.json()).error).toBe('reauth_required');
  expect((await client.post('/api/account/reauth', { data: { password: PASSWORD } })).status()).toBe(200);

  expect(await githubTrip(client, 'connect', github)).toBe('/account/security/?github=connected');
  expect((await (await client.get('/api/account/me')).json()).account).toMatchObject({ password: true, github: { login: github.login } });
  expect((await waitForMail(client, email, /^GitHub was connected to your pi-rust account$/)).text).toContain(github.login);
  expect((await (await client.post('/api/account/github/start', { data: { intent: 'connect' } })).json()).error).toBe('github_connected');

  const { client: someoneElse } = await verifiedAccount(playwright, baseURL!);
  expect(await githubTrip(someoneElse, 'connect', github)).toBe('/account/security/?github_error=taken');

  const browser = await accountClient(playwright, baseURL!);
  expect(await githubTrip(browser, 'sign-in', github)).toBe('/account/');
  expect((await (await browser.get('/api/account/me')).json()).account.email).toBe(email);
});

test('GitHub sign-in asks for the second step', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const github = githubAccount('two-step');
  const { secret } = await (await client.post('/api/account/totp/setup', { data: {} })).json();
  expect((await client.post('/api/account/totp/enable', { data: { code: totp(secret) } })).status()).toBe(200);
  expect(await githubTrip(client, 'connect', github)).toBe('/account/security/?github=connected');

  const browser = await accountClient(playwright, baseURL!);
  const location = new URL(await githubTrip(browser, 'sign-in', github, '/account/settings/'), baseURL);
  expect(location.pathname).toBe('/account/sign-in/');
  expect(Object.fromEntries(location.searchParams)).toEqual({ next: '/account/settings/', two_step: 'totp,recovery' });
  expect((await browser.get('/api/account/me')).status()).toBe(401);
  expect((await browser.post('/api/account/sign-in/totp', { data: { code: totp(secret, 1) } })).status()).toBe(200);
  expect((await (await browser.get('/api/account/me')).json()).account.email).toBe(email);
});

test('confirm it is you with GitHub, and disconnect only with another way to sign in', async ({ playwright, baseURL }) => {
  const client = await accountClient(playwright, baseURL!);
  const github = githubAccount('reauth');
  await githubTrip(client, 'sign-in', github);
  expect((await client.post('/api/account/github/sign-up', { data: TERMS })).status()).toBe(200);
  await devState(client, { action: 'age-reauth', email: github.email });
  expect((await client.delete('/api/account/github', { data: {} })).status()).toBe(403);

  expect(await githubTrip(client, 'reauth', githubAccount('stranger'), '/account/security/')).toBe('/account/security/?github_error=mismatch');
  expect(await githubTrip(client, 'reauth', github, '/account/security/')).toBe('/account/security/?github=confirmed');
  const last = await client.delete('/api/account/github', { data: {} });
  expect(last.status()).toBe(409);
  expect((await last.json()).error).toBe('last_sign_in_method');

  expect((await client.post('/api/account/password', { data: { password: PASSWORD } })).status()).toBe(200);
  expect((await client.delete('/api/account/github', { data: {} })).status()).toBe(200);
  expect((await waitForMail(client, github.email, /^GitHub was disconnected from your pi-rust account$/)).text).toContain(github.login);
  expect((await (await client.get('/api/account/me')).json()).account).toMatchObject({ password: true, github: null });
  expect(await githubTrip(await accountClient(playwright, baseURL!), 'sign-in', github)).toBe('/account/sign-in/?github=link');
  expect((await (await accountClient(playwright, baseURL!)).post('/api/account/sign-in', { data: { email: github.email, password: PASSWORD } })).status()).toBe(200);
});

test('a GitHub trip works once, in the browser that started it', async ({ playwright, baseURL }) => {
  const client = await accountClient(playwright, baseURL!);
  // Somewhere off the site is not a place to go afterwards.
  const start = await client.post('/api/account/github/start', { data: { intent: 'sign-in', next: '//evil.example/' } });
  const callback = await approveOnGitHub(client, (await start.json()).url, githubAccount('once'));
  const elsewhere = await accountClient(playwright, baseURL!);
  expect((await elsewhere.get(callback, { maxRedirects: 0 })).headers().location).toBe('/account/sign-in/?github_error=expired');
  expect((await client.get(callback, { maxRedirects: 0 })).headers().location).toBe('/account/sign-up/?github=1');
  expect((await client.get(callback, { maxRedirects: 0 })).headers().location).toBe('/account/sign-in/?github_error=expired');

  // Cancelling on GitHub goes back to where the sign-in started.
  const cancelled = await client.post('/api/account/github/start', { data: { intent: 'sign-in', next: '/account/settings/' } });
  const authorize = new URL((await cancelled.json()).url);
  const back = new URL((await client.get(`/__dev/github/approve?${authorize.searchParams}&cancel=1`, { maxRedirects: 0 })).headers().location);
  expect((await client.get(back.pathname + back.search, { maxRedirects: 0 })).headers().location).toBe('/account/sign-in/?next=%2Faccount%2Fsettings%2F');
});

/** Fills the fake GitHub's sign-in page the browser is on. */
async function approveOnPage(page: Page, account: FakeGitHubAccount): Promise<void> {
  await page.waitForURL(/\/__dev\/github\/authorize\?/);
  await page.getByLabel('GitHub user ID').fill(String(account.id));
  await page.getByLabel('Username').fill(account.login);
  await page.getByLabel('Primary email').fill(account.email);
  await page.getByRole('button', { name: 'Authorize' }).click();
}

test.describe('pages', () => {
  test.beforeEach(async ({ context }) => pageIp(context));

  test('sign up with GitHub, and confirm it is you with GitHub', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const github = githubAccount('pages');

    await page.goto('/account/sign-up/');
    await page.getByRole('button', { name: 'Sign up with GitHub' }).click();
    await approveOnPage(page, github);
    await page.waitForURL(/\/account\/sign-up\/\?github=1$/);
    await expect(page.locator('[data-github-login]')).toHaveText(github.login);
    await expect(page.locator('[data-github-email]')).toHaveText(github.email);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Confirm that you are 18 or older and agree to the Terms of Service.')).toBeVisible();
    await page.getByRole('checkbox', { name: /I agree to the Terms of Service/ }).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL(/\/account\/$/);

    await page.goto('/account/security/');
    await expect(page.locator('[data-github-status]')).toHaveText(`Connected to ${github.login} · Last used just now`);
    await expect(page.getByRole('button', { name: 'Set password' })).toBeVisible();

    // Without a password, "Confirm it's you" sends the browser to GitHub and back.
    await devState(page.request, { action: 'age-reauth', email: github.email });
    const disconnect = async () => {
      await page.getByRole('button', { name: 'Disconnect' }).click();
      await page.getByRole('dialog', { name: 'Disconnect GitHub?' }).getByRole('button', { name: 'Disconnect' }).click();
    };
    await disconnect();
    const confirm = page.getByRole('dialog', { name: 'Confirm it’s you' });
    await expect(confirm.getByText('Use GitHub to continue.')).toBeVisible();
    await expect(confirm.getByLabel('Password')).toBeHidden();
    await confirm.getByRole('button', { name: 'Use GitHub' }).click();
    await approveOnPage(page, github);
    await page.waitForURL(/\/account\/security\/$/);
    await expect(page.locator('[data-toast]')).toHaveText('Confirmed. Try again to continue.');
    await disconnect();
    await expect(page.locator('[data-toast]')).toHaveText('Set a password or add a passkey before you disconnect GitHub.');
    expect(errors).toEqual([]);
  });

  test('connect GitHub to an existing account by signing in to it', async ({ page, playwright, baseURL }) => {
    const email = uniqueEmail('page-link');
    await createVerified(await accountClient(playwright, baseURL!), email);
    const github = { ...githubAccount('page-link'), email };

    await page.goto('/account/sign-in/');
    await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
    await approveOnPage(page, github);
    await page.waitForURL(/\/account\/sign-in\/\?github=link$/);
    await expect(page.locator('[data-notice]')).toHaveText(`${email} already has an account. Sign in to connect the GitHub account ${github.login} to it.`);
    await expect(page.getByRole('textbox', { name: 'Email' })).toHaveValue(email);
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeHidden();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/account\/$/);
    await expect(page.locator('[data-toast]')).toHaveText('GitHub connected');
    await page.goto('/account/security/');
    await expect(page.locator('[data-github-status]')).toContainText(`Connected to ${github.login}`);
  });

  test('disconnect GitHub on the new-password page', async ({ page, playwright, baseURL }) => {
    const { client, email } = await verifiedAccount(playwright, baseURL!);
    const github = githubAccount('page-reset');
    expect(await githubTrip(client, 'connect', github)).toBe('/account/security/?github=connected');

    await page.goto(`/account/new-password/#token=${await resetToken(client, email)}`);
    await expect(page.locator('[data-github-hint]')).toHaveText(new RegExp(`^The GitHub account ${github.login}, connected .+, can still sign in to your account\\.$`));
    await page.getByLabel('New password').fill(NEW_PASSWORD);
    await page.getByRole('checkbox', { name: 'Also disconnect GitHub' }).check();
    await page.getByRole('button', { name: 'Save password' }).click();
    await page.waitForURL(/\/account\/sign-in\/\?reset=1$/);
    expect((await waitForMail(client, email, /^GitHub was disconnected from your pi-rust account$/)).text).toContain(github.login);
    expect((await waitForMail(client, email, /^Your pi-rust password was changed$/)).text).not.toContain('can still sign in');
    // No longer connected: its own email has no account, so GitHub offers a new one.
    expect(await githubTrip(await accountClient(playwright, baseURL!), 'sign-in', github)).toBe('/account/sign-up/?github=1');
  });

  test('sign in with GitHub, then the second step', async ({ page, playwright, baseURL }) => {
    const { client, email } = await verifiedAccount(playwright, baseURL!);
    const github = githubAccount('pages-two-step');
    const { secret } = await (await client.post('/api/account/totp/setup', { data: {} })).json();
    expect((await client.post('/api/account/totp/enable', { data: { code: totp(secret) } })).status()).toBe(200);
    expect(await githubTrip(client, 'connect', github)).toBe('/account/security/?github=connected');

    await page.goto('/account/sign-in/?next=%2Faccount%2Fsettings%2F');
    await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
    await approveOnPage(page, github);
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    await expect(page).toHaveURL(/\/account\/sign-in\/\?next=%2Faccount%2Fsettings%2F$/);
    await page.getByLabel('Code', { exact: true }).fill(totp(secret, 1));
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.waitForURL(/\/account\/settings\/$/);
    await expect(page.locator('[data-account-email]')).toHaveText(email);
  });
});
