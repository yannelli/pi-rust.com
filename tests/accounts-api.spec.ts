import { test, expect } from '@playwright/test';
import {
  accountClient,
  cliClient,
  cliToken,
  linkIn,
  devState,
  mailbox,
  PASSWORD,
  TERMS,
  tokenOf,
  totp,
  uniqueEmail,
  verifiedAccount,
  waitForMail,
} from './helpers/accounts';

test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'API tests need one browser project'));

test('sign up, verify by email, sign in, and sign out', async ({ playwright, baseURL }) => {
  const client = await accountClient(playwright, baseURL!);
  const email = uniqueEmail('signup');

  const signUp = await client.post('/api/account/sign-up', { data: { email, password: PASSWORD, ...TERMS } });
  expect(signUp.status()).toBe(200);
  expect(await signUp.json()).toEqual({ ok: true, next: 'check_email' });
  expect(signUp.headers()['set-cookie']).toBeUndefined();

  const mail = await waitForMail(client, email, /^Verify your email for pi-rust$/);
  expect(mail.html).toContain('Verify email');
  const link = linkIn(mail, /\/account\/verify\//);
  expect(link).toMatch(/\/account\/verify\/#token=[A-Za-z0-9_-]{43}$/);

  // Unverified accounts can sign in.
  expect((await client.post('/api/account/sign-in', { data: { email, password: PASSWORD } })).status()).toBe(200);
  expect((await (await client.get('/api/account/me')).json()).account).toMatchObject({ email, verified: false, totp: false, passkeys: 0 });

  const verify = await client.post('/api/account/verify', { data: { token: tokenOf(link) } });
  expect(await verify.json()).toEqual({ ok: true, signedIn: true });
  expect((await (await client.get('/api/account/me')).json()).account.verified).toBe(true);
  // Single use.
  const again = await client.post('/api/account/verify', { data: { token: tokenOf(link) } });
  expect(again.status()).toBe(400);
  expect((await again.json()).error).toBe('invalid_token');

  const signOut = await client.post('/api/account/sign-out', { data: {} });
  expect(signOut.status()).toBe(200);
  expect(signOut.headers()['set-cookie']).toContain('__Host-pirs_session=;');
  expect((await client.get('/api/account/me')).status()).toBe(401);
});

test('the session cookie is __Host-, HttpOnly, Secure, SameSite=Lax, and rotates on sign-in', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const first = (await client.storageState()).cookies.find((cookie) => cookie.name === '__Host-pirs_session')!;
  expect(first).toMatchObject({ path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
  expect(first.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(first.expires - Date.now() / 1000).toBeGreaterThan(29 * 24 * 3600);

  const signIn = await client.post('/api/account/sign-in', { data: { email, password: PASSWORD } });
  expect(signIn.headers()['set-cookie']).toMatch(/^__Host-pirs_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000/);
  const second = (await client.storageState()).cookies.find((cookie) => cookie.name === '__Host-pirs_session')!;
  expect(second.value).not.toBe(first.value);
  // The old session was ended, not just replaced in this browser.
  const sessions = (await (await client.get('/api/account/sessions')).json()).sessions;
  expect(sessions).toHaveLength(1);
});

test('sign-up and reset do not reveal whether an address has an account', async ({ playwright, baseURL }) => {
  const { email } = await verifiedAccount(playwright, baseURL!);
  const stranger = await accountClient(playwright, baseURL!);

  const taken = await stranger.post('/api/account/sign-up', { data: { email, password: 'another password 123', ...TERMS } });
  const fresh = await stranger.post('/api/account/sign-up', { data: { email: uniqueEmail('fresh'), password: 'another password 123', ...TERMS } });
  expect(taken.status()).toBe(fresh.status());
  expect(await taken.json()).toEqual(await fresh.json());
  const notice = await waitForMail(stranger, email, /Sign-up attempt/);
  expect(notice.text).toContain('already has an account');

  const known = await stranger.post('/api/account/reset/request', { data: { email } });
  const unknown = await stranger.post('/api/account/reset/request', { data: { email: uniqueEmail('nobody') } });
  expect(known.status()).toBe(200);
  expect(await known.json()).toEqual(await unknown.json());

  const wrongPassword = await stranger.post('/api/account/sign-in', { data: { email, password: 'not the password' } });
  const noAccount = await stranger.post('/api/account/sign-in', { data: { email: uniqueEmail('nobody'), password: 'not the password' } });
  expect(wrongPassword.status()).toBe(401);
  expect(await wrongPassword.json()).toEqual(await noAccount.json());
});

test('passwords need 10 to 256 characters and cannot be the email', async ({ playwright, baseURL }) => {
  const client = await accountClient(playwright, baseURL!);
  const email = uniqueEmail('rules');
  for (const password of ['short', 'x'.repeat(257), email, email.toUpperCase()]) {
    const response = await client.post('/api/account/sign-up', { data: { email, password, ...TERMS } });
    expect(response.status(), password).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: 'invalid_password', field: 'password' });
  }
  const badEmail = await client.post('/api/account/sign-up', { data: { email: 'not-an-email', password: PASSWORD, ...TERMS } });
  expect(await badEmail.json()).toMatchObject({ error: 'invalid_email', field: 'email' });
  expect(await mailbox(client, email)).toEqual([]);
});

test('sign-up needs the Terms box and the current Terms version, and writes or sends nothing without them', async ({ playwright, baseURL }) => {
  const { email: taken } = await verifiedAccount(playwright, baseURL!);
  const client = await accountClient(playwright, baseURL!);
  const email = uniqueEmail('terms');
  for (const [address, acceptTerms] of [[email, undefined], [email, false], [email, 'true'], [taken, undefined]] as const) {
    const response = await client.post('/api/account/sign-up', { data: { email: address, password: PASSWORD, acceptTerms, termsVersion: TERMS.termsVersion } });
    expect(response.status(), String(acceptTerms)).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: 'terms_required', field: 'acceptTerms' });
  }
  for (const termsVersion of [undefined, '2000-01-01']) {
    const response = await client.post('/api/account/sign-up', { data: { email, password: PASSWORD, acceptTerms: true, termsVersion } });
    expect(response.status(), String(termsVersion)).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: 'terms_changed', field: 'acceptTerms' });
  }
  expect(await mailbox(client, email)).toEqual([]);
  expect((await mailbox(client, taken)).filter((mail) => /Sign-up attempt/.test(mail.subject))).toEqual([]);

  const accepted = await client.post('/api/account/sign-up', { data: { email, password: PASSWORD, ...TERMS } });
  expect(await accepted.json()).toEqual({ ok: true, next: 'check_email' });
  await waitForMail(client, email, /Verify your email/);
});

test('password reset sets a new password and signs out every session and CLI token', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const token = await cliToken(playwright, baseURL!, client);
  const stranger = await accountClient(playwright, baseURL!);

  expect((await stranger.post('/api/account/reset/request', { data: { email } })).status()).toBe(200);
  const mail = await waitForMail(stranger, email, /Reset your pi-rust password/);
  const resetToken = tokenOf(linkIn(mail, /\/account\/new-password\//));

  const weak = await stranger.post('/api/account/reset', { data: { token: resetToken, password: 'short' } });
  expect(weak.status()).toBe(400);
  const reset = await stranger.post('/api/account/reset', { data: { token: resetToken, password: 'a brand new password' } });
  expect(await reset.json()).toEqual({ ok: true, next: 'sign_in' });
  expect((await stranger.post('/api/account/reset', { data: { token: resetToken, password: 'a third new password' } })).status()).toBe(400);
  await waitForMail(stranger, email, /password was changed/);

  expect((await client.get('/api/account/me')).status()).toBe(401);
  const cli = await cliClient(playwright, baseURL!, token);
  expect((await cli.get('/v1/account')).status()).toBe(401);
  expect((await stranger.post('/api/account/sign-in', { data: { email, password: PASSWORD } })).status()).toBe(401);
  expect((await stranger.post('/api/account/sign-in', { data: { email, password: 'a brand new password' } })).status()).toBe(200);
});

test('two-step verification: enroll, then sign in with a code or a recovery code', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const setup = await (await client.post('/api/account/totp/setup', { data: {} })).json();
  expect(setup.uri).toBe(`otpauth://totp/${encodeURIComponent(`pi-rust:${email}`)}?secret=${setup.secret}&issuer=pi-rust&algorithm=SHA1&digits=6&period=30`);
  expect((await client.post('/api/account/totp/enable', { data: { code: '000000' === totp(setup.secret) ? '111111' : '000000' } })).status()).toBe(400);
  const enable = await client.post('/api/account/totp/enable', { data: { code: totp(setup.secret) } });
  expect(enable.status()).toBe(200);
  const { recoveryCodes } = await enable.json();
  expect(recoveryCodes).toHaveLength(10);
  expect(new Set(recoveryCodes).size).toBe(10);
  for (const code of recoveryCodes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
  await waitForMail(client, email, /Two-step verification is on/);
  expect((await (await client.get('/api/account/me')).json()).account).toMatchObject({ totp: true, recoveryCodes: 10 });

  // A password alone no longer signs in.
  const browser = await accountClient(playwright, baseURL!);
  const first = await browser.post('/api/account/sign-in', { data: { email, password: PASSWORD } });
  expect(await first.json()).toEqual({ ok: true, next: 'two_step', methods: { totp: true, passkey: false, recovery: true } });
  expect((await browser.get('/api/account/me')).status()).toBe(401);
  const wrong = await browser.post('/api/account/sign-in/totp', { data: { code: totp(setup.secret, 5) } });
  expect(await wrong.json()).toMatchObject({ error: 'invalid_code', field: 'code' });
  // The next step's code: the enrollment used this step's code, and each step works once.
  const code = totp(setup.secret, 1);
  expect((await browser.post('/api/account/sign-in/totp', { data: { code } })).status()).toBe(200);
  expect((await browser.get('/api/account/me')).status()).toBe(200);

  // The same code again is refused.
  const replay = await accountClient(playwright, baseURL!);
  await replay.post('/api/account/sign-in', { data: { email, password: PASSWORD } });
  expect((await replay.post('/api/account/sign-in/totp', { data: { code } })).status()).toBe(401);

  // A recovery code works once and is reported by email.
  const recovery = await accountClient(playwright, baseURL!);
  await recovery.post('/api/account/sign-in', { data: { email, password: PASSWORD } });
  expect((await recovery.post('/api/account/sign-in/recovery', { data: { code: recoveryCodes[0].toUpperCase() } })).status()).toBe(200);
  expect((await (await recovery.get('/api/account/me')).json()).account.recoveryCodes).toBe(9);
  const used = await waitForMail(recovery, email, /recovery code was used/);
  expect(used.text).toContain('9 codes are left');
  const reuse = await accountClient(playwright, baseURL!);
  await reuse.post('/api/account/sign-in', { data: { email, password: PASSWORD } });
  expect((await reuse.post('/api/account/sign-in/recovery', { data: { code: recoveryCodes[0] } })).status()).toBe(401);
});

test('the second step allows five wrong codes, then the sign-in starts over', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const { secret } = await (await client.post('/api/account/totp/setup', { data: {} })).json();
  await client.post('/api/account/totp/enable', { data: { code: totp(secret) } });
  const browser = await accountClient(playwright, baseURL!);
  await browser.post('/api/account/sign-in', { data: { email, password: PASSWORD } });
  const errors: string[] = [];
  for (let i = 0; i < 5; i++) errors.push((await (await browser.post('/api/account/sign-in/totp', { data: { code: '12345' + i } })).json()).error);
  expect(errors).toEqual(['invalid_code', 'invalid_code', 'invalid_code', 'invalid_code', 'sign_in_expired']);
  expect((await (await browser.post('/api/account/sign-in/totp', { data: { code: totp(secret, 1) } })).json()).error).toBe('sign_in_expired');
});

test('sensitive actions need a confirmation from the last 10 minutes', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  await devState(client, { action: 'age-reauth', email });
  for (const [path, data] of [
    ['password', { password: 'another long password' }],
    ['totp/setup', {}],
    ['recovery-codes', {}],
    ['passkeys/options', {}],
    ['sessions/revoke-others', {}],
    ['delete', {}],
  ] as const) {
    const response = await client.post(`/api/account/${path}`, { data });
    expect(response.status(), path).toBe(403);
    expect((await response.json()).error, path).toBe('reauth_required');
  }
  expect((await client.post('/api/account/reauth', { data: { password: 'wrong password!' } })).status()).toBe(401);
  expect((await client.post('/api/account/reauth', { data: { password: PASSWORD } })).status()).toBe(200);
  expect((await client.post('/api/account/password', { data: { password: 'another long password' } })).status()).toBe(200);
  await waitForMail(client, email, /password was changed/);
});

test('state-changing account requests must be JSON from the site origin', async ({ playwright, baseURL }) => {
  const { client } = await verifiedAccount(playwright, baseURL!);
  const evil = await client.post('/api/account/sign-out', { data: {}, headers: { Origin: 'https://evil.example' } });
  expect(evil.status()).toBe(403);
  expect((await evil.json()).error).toBe('bad_origin');
  const crossSite = await client.post('/api/account/sign-out', { data: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  expect(crossSite.status()).toBe(403);
  const form = await client.post('/api/account/sign-out', { form: { a: '1' } });
  expect(form.status()).toBe(415);
  const text = await client.post('/api/account/sign-out', { data: 'x', headers: { 'Content-Type': 'text/plain' } });
  expect(text.status()).toBe(415);
  // Still signed in: none of these did anything.
  expect((await client.get('/api/account/me')).status()).toBe(200);

  const noOrigin = await playwright.request.newContext({ baseURL, storageState: await client.storageState() });
  expect((await noOrigin.post('/api/account/sign-out', { data: {} })).status()).toBe(403);
});

test('account API responses carry no-store and security headers', async ({ playwright, baseURL }) => {
  const client = await accountClient(playwright, baseURL!);
  const response = await client.get('/api/account/me');
  expect(response.status()).toBe(401);
  expect(response.headers()).toMatchObject({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  expect((await client.get('/api/account/nope')).status()).toBe(404);
  expect((await client.get('/api/account/sign-in')).status()).toBe(405);
});

test('auth endpoints are rate limited per client IP', async ({ playwright, baseURL }) => {
  const client = await accountClient(playwright, baseURL!);
  const statuses: number[] = [];
  // 21 requests, so a minute boundary during the loop still leaves one over the limit.
  for (let i = 0; i < 21; i++) {
    statuses.push((await client.post('/api/account/sign-in', { data: { email: 'nobody@example.com', password: 'wrong password' } })).status());
  }
  expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
  expect(statuses).toContain(429);
  const limited = await client.post('/api/account/sign-in', { data: { email: 'nobody@example.com', password: 'wrong password' } });
  if (limited.status() === 429) expect(await limited.json()).toMatchObject({ ok: false, error: 'rate_limited' });
});

test('sessions and CLI tokens can be listed and revoked', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const other = await accountClient(playwright, baseURL!);
  await other.post('/api/account/sign-in', { data: { email, password: PASSWORD } });
  const token = await cliToken(playwright, baseURL!, client);

  const { sessions } = await (await client.get('/api/account/sessions')).json();
  expect(sessions).toHaveLength(2);
  expect(sessions.filter((session: { current: boolean }) => session.current)).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ id: expect.any(String), label: expect.any(String), createdAt: expect.any(String), lastSeenAt: expect.any(String) });

  expect((await client.post('/api/account/sessions/revoke-others', { data: {} })).status()).toBe(200);
  expect((await other.get('/api/account/me')).status()).toBe(401);

  const { tokens } = await (await client.get('/api/account/tokens')).json();
  expect(tokens).toEqual([{ id: expect.any(String), name: 'pi CLI', createdAt: expect.any(String), lastUsedAt: null }]);
  const cli = await cliClient(playwright, baseURL!, token);
  expect((await cli.get('/v1/account')).status()).toBe(200);
  expect((await (await client.get('/api/account/tokens')).json()).tokens[0].lastUsedAt).toEqual(expect.any(String));
  expect((await client.delete(`/api/account/tokens/${tokens[0].id}`, { data: {} })).status()).toBe(200);
  expect((await cli.get('/v1/account')).status()).toBe(401);
});
