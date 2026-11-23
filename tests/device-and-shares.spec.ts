import { test, expect, type APIRequestContext } from '@playwright/test';
import { accountClient, cliClient, cliToken, devState, PASSWORD, TERMS, uniqueEmail, verifiedAccount, waitForMail } from './helpers/accounts';

test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'API tests need one browser project'));

const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

async function authorize(cli: APIRequestContext) {
  const response = await cli.post('/oauth/device_authorization', { form: { client_id: 'pi-cli', scope: 'share' } });
  expect(response.status()).toBe(200);
  return response.json();
}

const poll = (cli: APIRequestContext, deviceCode: string, clientId = 'pi-cli') =>
  cli.post('/oauth/token', { form: { grant_type: GRANT, device_code: deviceCode, client_id: clientId } });

async function errorOf(response: Awaited<ReturnType<typeof poll>>): Promise<string> {
  expect(response.status()).toBe(400);
  return (await response.json()).error;
}

test('device grant: the CLI gets a token once the user approves', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const cli = await cliClient(playwright, baseURL!);
  const grant = await authorize(cli);
  expect(grant).toEqual({
    device_code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    user_code: expect.stringMatching(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/),
    verification_uri: `${baseURL}/device`,
    verification_uri_complete: `${baseURL}/device?user_code=${grant.user_code}`,
    expires_in: 900,
    interval: 5,
  });

  expect(await errorOf(await poll(cli, grant.device_code))).toBe('authorization_pending');
  // Polling again before the interval is up asks the CLI to slow down.
  expect(await errorOf(await poll(cli, grant.device_code))).toBe('slow_down');

  // The page looks the code up in any case and with or without the dash.
  const typed = grant.user_code.replace('-', '').toLowerCase();
  const lookup = await client.get(`/api/account/device?user_code=${typed}`);
  expect((await lookup.json()).request).toMatchObject({ userCode: grant.user_code, client: 'pi 0.12.26 on Linux' });
  expect((await client.post('/api/account/device/approve', { data: { user_code: typed } })).status()).toBe(200);
  expect((await client.post('/api/account/device/approve', { data: { user_code: typed } })).status()).toBe(404);

  const token = await poll(cli, grant.device_code);
  expect(token.status()).toBe(200);
  const body = await token.json();
  expect(body).toEqual({ access_token: expect.stringMatching(/^pirs_[A-Za-z0-9_-]{43}$/), token_type: 'Bearer', scope: 'share', account: { email } });
  expect(token.headers()['cache-control']).toBe('no-store');
  // The device code works once.
  expect(await errorOf(await poll(cli, grant.device_code))).toBe('invalid_grant');

  const authed = await cliClient(playwright, baseURL!, body.access_token);
  expect(await (await authed.get('/v1/account')).json()).toEqual({ ok: true, account: { email } });
  const revoke = await authed.delete('/v1/token');
  expect(revoke.status()).toBe(204);
  const after = await authed.get('/v1/account');
  expect(after.status()).toBe(401);
  expect(await after.json()).toMatchObject({ ok: false, error: 'unauthorized', description: expect.any(String) });
});

test('device grant: deny, expiry, and bad requests', async ({ playwright, baseURL }) => {
  const { client } = await verifiedAccount(playwright, baseURL!);
  const cli = await cliClient(playwright, baseURL!);

  const denied = await authorize(cli);
  expect((await client.post('/api/account/device/deny', { data: { user_code: denied.user_code } })).status()).toBe(200);
  expect(await errorOf(await poll(cli, denied.device_code))).toBe('access_denied');
  expect(await errorOf(await poll(cli, denied.device_code))).toBe('invalid_grant');

  const expired = await authorize(cli);
  await devState(cli, { action: 'expire-device-code', userCode: expired.user_code });
  expect(await errorOf(await poll(cli, expired.device_code))).toBe('expired_token');
  const late = await client.post('/api/account/device/approve', { data: { user_code: expired.user_code } });
  expect(late.status()).toBe(410);

  expect(await errorOf(await poll(cli, 'not-a-real-device-code'))).toBe('invalid_grant');
  expect(await errorOf(await poll(cli, expired.device_code, 'someone-else'))).toBe('invalid_client');
  const wrongGrant = await cli.post('/oauth/token', { form: { grant_type: 'password', client_id: 'pi-cli' } });
  expect(await errorOf(wrongGrant)).toBe('unsupported_grant_type');
  const wrongClient = await cli.post('/oauth/device_authorization', { form: { client_id: 'other', scope: 'share' } });
  expect(await errorOf(wrongClient)).toBe('invalid_client');
  expect((await client.post('/api/account/device/approve', { data: { user_code: 'AAAA-AAAA' } })).status()).toBe(404);
});

test('an unverified account cannot approve a CLI or share', async ({ playwright, baseURL }) => {
  const client = await accountClient(playwright, baseURL!);
  const email = uniqueEmail('unverified');
  await client.post('/api/account/sign-up', { data: { email, password: PASSWORD, ...TERMS } });
  await waitForMail(client, email, /Verify your email/);
  await client.post('/api/account/sign-in', { data: { email, password: PASSWORD } });
  const grant = await authorize(await cliClient(playwright, baseURL!));
  const approve = await client.post('/api/account/device/approve', { data: { user_code: grant.user_code } });
  expect(approve.status()).toBe(403);
  expect((await approve.json()).error).toBe('email_not_verified');

  // A token from before the address stopped being verified cannot share either.
  const { client: verified, email: other } = await verifiedAccount(playwright, baseURL!);
  const token = await cliToken(playwright, baseURL!, verified);
  await devState(verified, { action: 'unverify', email: other });
  const upload = await (await cliClient(playwright, baseURL!, token)).post('/v1/shares', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    data: '<p>hi</p>',
  });
  expect(upload.status()).toBe(403);
  expect(await upload.json()).toMatchObject({ ok: false, error: 'email_not_verified' });
});

test('shares: upload, list, view in a sandbox, delete', async ({ playwright, baseURL }) => {
  const { client } = await verifiedAccount(playwright, baseURL!);
  const cli = await cliClient(playwright, baseURL!, await cliToken(playwright, baseURL!, client));
  const html = '<!doctype html><title>t</title><h1>Shared</h1><script>document.body.dataset.ran = "1"</script>';

  const created = await cli.post(`/v1/shares?title=${encodeURIComponent('Fix the parser')}`, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, data: html });
  expect(created.status()).toBe(201);
  const { share } = await created.json();
  expect(share).toEqual({
    id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    url: `${baseURL}/s/${share.id}`,
    title: 'Fix the parser',
    size: Buffer.byteLength(html),
    createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    // Without expires_in and visibility, as old clients send it: no expiry, anyone with the link.
    expiresAt: null,
    visibility: 'link',
    views: 0,
    lastViewedAt: null,
  });

  const untitled = await (await cli.post('/v1/shares', { headers: { 'Content-Type': 'text/html' }, data: '<p>x</p>' })).json();
  expect(untitled.share.title).toBe('Pi session');
  const long = await (await cli.post(`/v1/shares?title=${'a'.repeat(300)}`, { headers: { 'Content-Type': 'text/html' }, data: '<p>x</p>' })).json();
  expect(long.share.title).toHaveLength(200);

  const list = await (await cli.get('/v1/shares')).json();
  expect(list.ok).toBe(true);
  expect(list.shares.map((item: { id: string }) => item.id)).toEqual([long.share.id, untitled.share.id, share.id]);
  expect((await (await client.get('/api/account/shares')).json()).shares).toHaveLength(3);

  const view = await (await accountClient(playwright, baseURL!)).get(`/s/${share.id}`);
  expect(view.status()).toBe(200);
  // The Worker adds only the robots and link-preview tags.
  expect((await view.text()).replace(/<meta [^>]*>/g, '')).toBe(html);
  expect(view.headers()).toMatchObject({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
    'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-cache',
  });

  expect((await cli.delete(`/v1/shares/${share.id}`)).status()).toBe(204);
  const gone = await cli.get(`/s/${share.id}`);
  expect(gone.status()).toBe(404);
  expect(await gone.text()).toContain('Share not found');
  expect((await cli.delete(`/v1/shares/${share.id}`)).status()).toBe(404);
  expect((await client.delete(`/api/account/shares/${untitled.share.id}`, { data: {} })).status()).toBe(200);
  expect((await cli.get(`/s/${untitled.share.id}`)).status()).toBe(404);
  expect((await cli.get('/s/unknown-share-id-000000')).status()).toBe(404);
});

test('a shared page runs with an opaque origin and cannot call the account API', async ({ page, playwright, baseURL }) => {
  const { client } = await verifiedAccount(playwright, baseURL!);
  const cli = await cliClient(playwright, baseURL!, await cliToken(playwright, baseURL!, client));
  const html = `<!doctype html><p id="out">waiting</p><script>
    fetch('/api/account/sign-out', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => r.status, () => 'blocked')
      .then((status) => { document.getElementById('out').textContent = origin + ' ' + status; });
  </script>`;
  const { share } = await (await cli.post('/v1/shares', { headers: { 'Content-Type': 'text/html' }, data: html })).json();
  await page.goto(`/s/${share.id}`);
  await expect(page.locator('#out')).toHaveText(/^null (blocked|403)$/);
});

test('share upload errors use the CLI error format', async ({ playwright, baseURL }) => {
  const anonymous = await cliClient(playwright, baseURL!);
  const noToken = await anonymous.post('/v1/shares', { headers: { 'Content-Type': 'text/html' }, data: '<p>x</p>' });
  expect(noToken.status()).toBe(401);
  expect(await noToken.json()).toEqual({ ok: false, error: 'unauthorized', description: expect.any(String) });
  expect((await (await cliClient(playwright, baseURL!, 'pirs_' + 'x'.repeat(43))).get('/v1/shares')).status()).toBe(401);

  const { client } = await verifiedAccount(playwright, baseURL!);
  const cli = await cliClient(playwright, baseURL!, await cliToken(playwright, baseURL!, client));
  const json = await cli.post('/v1/shares', { data: { html: '<p>x</p>' } });
  expect(json.status()).toBe(415);
  expect((await json.json()).error).toBe('unsupported_media_type');
  const big = await cli.post('/v1/shares', { headers: { 'Content-Type': 'text/html' }, data: Buffer.alloc(25 * 1024 * 1024 + 1, 'a') });
  expect(big.status()).toBe(413);
  expect((await big.json()).error).toBe('too_large');
  expect((await cli.delete('/v1/shares/AAAAAAAAAAAAAAAAAAAAAA')).status()).toBe(404);
});

test('share uploads are rate limited per token', async ({ playwright, baseURL }) => {
  const { client } = await verifiedAccount(playwright, baseURL!);
  const cli = await cliClient(playwright, baseURL!, await cliToken(playwright, baseURL!, client));
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++) statuses.push((await cli.post('/v1/shares', { headers: { 'Content-Type': 'text/html' }, data: `<p>${i}</p>` })).status());
  expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
  expect(statuses).toContain(429);
});

test('deleting the account deletes its shares, tokens, and sign-in', async ({ playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  const token = await cliToken(playwright, baseURL!, client);
  const cli = await cliClient(playwright, baseURL!, token);
  const { share } = await (await cli.post('/v1/shares', { headers: { 'Content-Type': 'text/html' }, data: '<p>mine</p>' })).json();
  expect((await cli.get(`/s/${share.id}`)).status()).toBe(200);

  const deleted = await client.post('/api/account/delete', { data: {} });
  expect(deleted.status()).toBe(200);
  expect(deleted.headers()['set-cookie']).toContain('Max-Age=0');
  await waitForMail(client, email, /account was deleted/);

  expect((await cli.get(`/s/${share.id}`)).status()).toBe(404);
  expect((await cli.get('/v1/account')).status()).toBe(401);
  expect((await client.get('/api/account/me')).status()).toBe(401);
  expect((await client.post('/api/account/sign-in', { data: { email, password: PASSWORD } })).status()).toBe(401);
  // The address is free again.
  expect((await client.post('/api/account/sign-up', { data: { email, password: PASSWORD, ...TERMS } })).status()).toBe(200);
  await waitForMail(client, email, /Verify your email/);
});
