// The admin API: who gets in, people (roles, suspension, sign out, deletion), shares, bug reports,
// the activity log, and the admin pages' gate.

import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  accountClient,
  adminAccount,
  cliClient,
  cliToken,
  devState,
  githubAccount,
  githubTrip,
  PASSWORD,
  uniqueEmail,
  verifiedAccount,
  waitForMail,
  testIp,
} from './helpers/accounts';

test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'API tests need one browser project'));

const HTML = { 'Content-Type': 'text/html; charset=utf-8' };
const PAGE = '<!doctype html><html><head><title>t</title></head><body><h1>Shared</h1></body></html>';

interface Person {
  id: string;
  email: string;
  admin: boolean;
  suspendedAt: string | null;
  shares: number;
  cliTokens: number;
  github: string | null;
  you: boolean;
}

async function findPerson(admin: APIRequestContext, email: string): Promise<Person> {
  const response = await admin.get(`/api/admin/users?q=${encodeURIComponent(email)}`);
  expect(response.status()).toBe(200);
  const { users } = await response.json();
  expect(users).toHaveLength(1);
  return users[0];
}

async function upload(cli: APIRequestContext, query = ''): Promise<{ id: string; url: string }> {
  const response = await cli.post(`/v1/shares${query}`, { headers: HTML, data: PAGE });
  expect(response.status()).toBe(201);
  return (await response.json()).share;
}

test('only admins with two-step verification get in', async ({ playwright, baseURL }) => {
  const signedOut = await accountClient(playwright, baseURL!);
  expect((await signedOut.get('/api/admin/overview')).status()).toBe(401);
  const page = await signedOut.get('/admin/people/', { maxRedirects: 0 });
  expect(page.status()).toBe(302);
  expect(page.headers().location).toBe('/account/sign-in/?next=%2Fadmin%2Fpeople%2F');

  const { client: user, email } = await verifiedAccount(playwright, baseURL!);
  const forbidden = await user.get('/api/admin/overview');
  expect(forbidden.status()).toBe(403);
  expect((await forbidden.json()).error).toBe('forbidden');
  // To anyone signed in but an admin, the admin pages do not exist.
  const hidden = await user.get('/admin/');
  expect(hidden.status()).toBe(404);
  expect(await hidden.text()).not.toContain('data-admin-content');
  expect((await (await user.get('/api/account/me')).json()).account.admin).toBe(false);

  // An admin without a second step gets the page, but not the data.
  await devState(user, { action: 'make-admin', email });
  expect((await (await user.get('/api/account/me')).json()).account.admin).toBe(true);
  const gated = await user.get('/api/admin/overview');
  expect(gated.status()).toBe(403);
  expect((await gated.json()).error).toBe('two_step_required');
  const served = await user.get('/admin/');
  expect(served.status()).toBe(200);
  expect(served.headers()['x-robots-tag']).toBe('noindex, nofollow');
  expect(served.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(await served.text()).toContain('data-admin-gate');

  const { client: admin } = await adminAccount(playwright, baseURL!);
  const overview = await admin.get('/api/admin/overview');
  expect(overview.status()).toBe(200);
  const body = await overview.json();
  expect(body.accounts.total).toBeGreaterThanOrEqual(2);
  expect(body.accounts.admins).toBeGreaterThanOrEqual(1);
  expect(body.days).toHaveLength(30);
  expect(body.days[29]).toEqual({ date: new Date().toISOString().slice(0, 10), signUps: expect.any(Number), shares: expect.any(Number) });
  expect(body.days[29].signUps).toBeGreaterThanOrEqual(2);
  // No Cloudflare API token in wrangler dev.
  expect(await (await admin.get('/api/admin/installs')).json()).toEqual({ ok: true, configured: false });
  expect((await (await admin.get('/api/admin/versions')).json()).requests).toEqual({ configured: false });

  // State-changing calls follow the account API's CSRF rules.
  const target = await findPerson(admin, email);
  const cli = await cliClient(playwright, baseURL!);
  const crossSite = await cli.post(`/api/admin/users/${target.id}/restore`, { headers: { Cookie: (await admin.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join('; ') }, data: {} });
  expect(crossSite.status()).toBe(403);
  expect((await crossSite.json()).error).toBe('bad_origin');
});

test('suspending an account signs it out, stops its CLI and shares, and restoring undoes it', async ({ playwright, baseURL }) => {
  const { client: admin, email: adminEmail } = await adminAccount(playwright, baseURL!);
  const { client: user, email } = await verifiedAccount(playwright, baseURL!);
  const cli = await cliClient(playwright, baseURL!, await cliToken(playwright, baseURL!, user));
  const share = await upload(cli, '?title=Spam');
  const person = await findPerson(admin, email);
  expect(person).toMatchObject({ email, admin: false, suspendedAt: null, shares: 1, cliTokens: 1, you: false });

  // Changes need a confirmation from the last 10 minutes; signing in was one.
  await devState(admin, { action: 'age-reauth', email: adminEmail });
  const stale = await admin.post(`/api/admin/users/${person.id}/suspend`, { data: {} });
  expect(stale.status()).toBe(403);
  expect((await stale.json()).error).toBe('reauth_required');
  expect((await admin.post('/api/account/reauth', { data: { password: PASSWORD } })).status()).toBe(200);

  expect((await admin.post(`/api/admin/users/${person.id}/suspend`, { data: { reason: 'Spam links' } })).status()).toBe(200);
  expect((await user.get('/api/account/me')).status()).toBe(401);
  expect((await cli.get('/v1/account')).status()).toBe(401);
  expect((await cli.get(share.url)).status()).toBe(404);
  const signIn = await (await accountClient(playwright, baseURL!)).post('/api/account/sign-in', { data: { email, password: PASSWORD } });
  expect(signIn.status()).toBe(403);
  expect(await signIn.json()).toMatchObject({ error: 'account_suspended', description: 'This account is suspended.' });
  // A wrong password still gets the usual answer, so suspension is only revealed to the owner.
  const wrong = await (await accountClient(playwright, baseURL!)).post('/api/account/sign-in', { data: { email, password: 'not the password' } });
  expect(wrong.status()).toBe(401);

  const suspended = await findPerson(admin, email);
  expect(suspended.suspendedAt).not.toBeNull();
  expect(suspended.cliTokens).toBe(0);
  const listed = (await (await admin.get(`/api/admin/users?filter=suspended&q=${encodeURIComponent(email)}`)).json()).users;
  expect(listed.map((row: Person) => row.email)).toEqual([email]);
  // A suspended account cannot be made an admin.
  expect((await (await admin.post(`/api/admin/users/${person.id}/role`, { data: { role: 'admin' } })).json()).error).toBe('suspended');

  expect((await admin.post(`/api/admin/users/${person.id}/restore`, { data: {} })).status()).toBe(200);
  const again = await accountClient(playwright, baseURL!);
  expect((await again.post('/api/account/sign-in', { data: { email, password: PASSWORD } })).status()).toBe(200);
  expect((await again.get(share.url)).status()).toBe(200);

  const { events } = await (await admin.get('/api/admin/activity')).json();
  const mine = events.filter((event: { admin: string }) => event.admin === adminEmail);
  expect(mine.slice(0, 2)).toEqual([
    expect.objectContaining({ action: 'restore', target: { type: 'account', id: person.id, label: email }, detail: null }),
    expect.objectContaining({ action: 'suspend', target: { type: 'account', id: person.id, label: email }, detail: 'Spam links' }),
  ]);
});

test('admins change roles, sign accounts out, and delete them, but never their own or another admin', async ({ playwright, baseURL }) => {
  const { client: admin, email: adminEmail } = await adminAccount(playwright, baseURL!);
  const self = await findPerson(admin, adminEmail);
  expect(self).toMatchObject({ admin: true, you: true });
  for (const action of ['suspend', 'delete', 'sign-out']) {
    const response = await admin.post(`/api/admin/users/${self.id}/${action}`, { data: {} });
    expect(response.status()).toBe(409);
    expect((await response.json()).error).toBe('own_account');
  }

  const { client: user, email } = await verifiedAccount(playwright, baseURL!);
  const person = await findPerson(admin, email);
  expect((await admin.post(`/api/admin/users/${person.id}/role`, { data: { role: 'owner' } })).status()).toBe(400);
  expect((await admin.post(`/api/admin/users/${person.id}/role`, { data: { role: 'admin' } })).status()).toBe(200);
  expect((await (await user.get('/api/account/me')).json()).account.admin).toBe(true);
  for (const action of ['suspend', 'delete']) {
    const response = await admin.post(`/api/admin/users/${person.id}/${action}`, { data: {} });
    expect(response.status()).toBe(409);
    expect((await response.json()).error).toBe('is_admin');
  }
  expect((await admin.post(`/api/admin/users/${person.id}/role`, { data: { role: 'user' } })).status()).toBe(200);
  expect((await (await admin.get(`/api/admin/users?filter=admins&q=${encodeURIComponent(email)}`)).json()).users).toEqual([]);

  expect((await admin.post(`/api/admin/users/${person.id}/sign-out`, { data: {} })).status()).toBe(200);
  expect((await user.get('/api/account/me')).status()).toBe(401);

  // Signed in again, with a share, before the account is deleted.
  const back = await accountClient(playwright, baseURL!);
  expect((await back.post('/api/account/sign-in', { data: { email, password: PASSWORD } })).status()).toBe(200);
  const share = await upload(await cliClient(playwright, baseURL!, await cliToken(playwright, baseURL!, back)));
  const cli = await cliClient(playwright, baseURL!);
  expect((await admin.post(`/api/admin/users/${person.id}/delete`, { data: {} })).status()).toBe(200);
  await waitForMail(admin, email, /^Your pi-rust account was deleted$/);
  expect((await cli.get(share.url)).status()).toBe(404);
  expect((await admin.get(`/api/admin/users?q=${encodeURIComponent(email)}`)).ok()).toBe(true);
  expect((await (await admin.get(`/api/admin/users?q=${encodeURIComponent(email)}`)).json()).users).toEqual([]);
  expect((await admin.post(`/api/admin/users/${person.id}/delete`, { data: {} })).status()).toBe(404);
});

test('admins see the connected GitHub username and find accounts by it', async ({ playwright, baseURL }) => {
  const { client: admin } = await adminAccount(playwright, baseURL!);
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  expect((await findPerson(admin, email)).github).toBeNull();
  const github = githubAccount('admin-view');
  expect(await githubTrip(client, 'connect', github)).toBe('/account/security/?github=connected');
  expect(await findPerson(admin, github.login)).toMatchObject({ email, github: github.login });
});

test('admins list every share, make one private, and delete one; their views are not counted', async ({ playwright, baseURL }) => {
  const { client: admin } = await adminAccount(playwright, baseURL!);
  const { client: owner, email } = await verifiedAccount(playwright, baseURL!);
  const cli = await cliClient(playwright, baseURL!, await cliToken(playwright, baseURL!, owner));
  const open = await upload(cli, '?title=Public%20one');
  const closed = await upload(cli, '?title=Private%20one&visibility=private');

  const { shares, total } = await (await admin.get(`/api/admin/shares?q=${encodeURIComponent(email)}`)).json();
  expect(total).toBe(2);
  const byId = Object.fromEntries(shares.map((share: { id: string }) => [share.id, share]));
  expect(byId[open.id]).toMatchObject({ title: 'Public one', visibility: 'link', url: open.url, views: 0, owner: { email, suspended: false } });
  // A private share's details are listed, never a link to it.
  expect(byId[closed.id]).toMatchObject({ title: 'Private one', visibility: 'private', url: null });
  expect((await (await admin.get(`/api/admin/shares?q=${closed.id}`)).json()).shares.map((s: { id: string }) => s.id)).toEqual([closed.id]);
  expect((await (await admin.get(`/api/admin/shares?filter=private&q=${encodeURIComponent(email)}`)).json()).total).toBe(1);
  // The owner's private share is still a 404 to an admin.
  expect((await admin.get(closed.url)).status()).toBe(404);

  expect((await admin.get(open.url)).status()).toBe(200);
  const stranger = await accountClient(playwright, baseURL!);
  expect((await stranger.get(open.url)).status()).toBe(200);
  // Views are counted after the response; the stranger's counts, the admin's does not.
  const views = async () => (await (await admin.get(`/api/admin/shares?q=${open.id}`)).json()).shares[0].views;
  await expect.poll(views).toBeGreaterThanOrEqual(1);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await views()).toBe(1);

  expect((await admin.post(`/api/admin/shares/${open.id}/hide`, { data: {} })).status()).toBe(200);
  expect((await stranger.get(open.url)).status()).toBe(404);
  expect((await owner.get(open.url)).status()).toBe(200);

  expect((await admin.delete(`/api/admin/shares/${open.id}`, { data: {} })).status()).toBe(200);
  expect((await owner.get(open.url)).status()).toBe(404);
  expect((await admin.delete(`/api/admin/shares/${open.id}`, { data: {} })).status()).toBe(404);
  const { events } = await (await admin.get('/api/admin/activity')).json();
  expect(events.filter((event: { target: { id: string } }) => event.target.id === open.id).map((event: { action: string }) => event.action)).toEqual(['delete-share', 'hide-share']);
});

test('bug reports: listed on upload, read, downloaded, closed, deleted, and indexed again by the cleanup', async ({ playwright, baseURL, request }) => {
  const { client: admin } = await adminAccount(playwright, baseURL!);
  const id = crypto.randomUUID();
  const hint = `Crash on resume ${id.slice(0, 8)}\nSteps: open, resume.`;
  const report = { id, hint, environment: { version: '0.12.30', platform: 'linux', arch: 'x64' }, model: { provider: 'anthropic', id: 'claude' }, session: { included: true } };
  const upload = await request.post('/v1/bug-reports', {
    // A client IP of its own: the bug report limiter allows 5 a minute per IP.
    headers: { 'CF-Connecting-IP': testIp() },
    multipart: {
      'report.json': { name: 'report.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report)) },
      'diagnostics.json': { name: 'diagnostics.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ assistant: [{}], crashes: [] })) },
      'session.jsonl': { name: 'session.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from('{"type":"session"}\n') },
    },
  });
  expect(upload.status()).toBe(201);

  const { reports } = await (await admin.get(`/api/admin/bug-reports?q=${id}`)).json();
  expect(reports).toEqual([
    {
      id,
      receivedAt: expect.any(String),
      description: hint,
      version: '0.12.30',
      platform: 'linux x64',
      model: 'anthropic/claude',
      files: [
        { name: 'report.json', size: expect.any(Number) },
        { name: 'diagnostics.json', size: expect.any(Number) },
        { name: 'session.jsonl', size: 19 },
      ],
      size: expect.any(Number),
      status: 'open',
      closedAt: null,
    },
  ]);
  expect((await (await admin.get(`/api/admin/bug-reports?q=${encodeURIComponent(`Crash on resume ${id.slice(0, 8)}`)}`)).json()).total).toBe(1);

  const detail = await (await admin.get(`/api/admin/bug-reports/${id}`)).json();
  expect(detail.reportJson).toEqual(report);
  expect(detail.diagnostics).toEqual({ assistant: [{}], crashes: [] });
  const file = await admin.get(`/api/admin/bug-reports/${id}/files/session.jsonl`);
  expect(file.status()).toBe(200);
  expect(file.headers()['content-disposition']).toBe(`attachment; filename="bug-${id.slice(0, 8)}-session.jsonl"`);
  expect(await file.text()).toBe('{"type":"session"}\n');
  expect((await admin.get(`/api/admin/bug-reports/${id}/files/summary.md`)).status()).toBe(404);
  expect((await admin.get(`/api/admin/bug-reports/${id}/files/secrets.txt`)).status()).toBe(404);

  expect((await admin.patch(`/api/admin/bug-reports/${id}`, { data: { status: 'closed' } })).status()).toBe(200);
  expect((await (await admin.get(`/api/admin/bug-reports?q=${id}`)).json()).total).toBe(0);
  expect((await (await admin.get(`/api/admin/bug-reports?status=closed&q=${id}`)).json()).reports[0]).toMatchObject({ status: 'closed', closedAt: expect.any(String) });

  // A report whose row is missing (a failed write, or one from before the admin area) is listed again by the cleanup.
  await devState(admin, { action: 'unindex-bug-report', id });
  expect((await (await admin.get(`/api/admin/bug-reports?status=all&q=${id}`)).json()).total).toBe(0);
  const run = await (await admin.post('/__dev/cleanup', { data: { now: 2 * 24 * 3600 * 1000 } })).json();
  expect(run.deleted.bugReportsIndexed).toBeGreaterThanOrEqual(1);
  const indexed = (await (await admin.get(`/api/admin/bug-reports?q=${id}`)).json()).reports[0];
  expect(indexed).toMatchObject({ id, description: hint, version: '0.12.30', platform: 'linux x64', model: 'anthropic/claude', status: 'open' });

  expect((await admin.delete(`/api/admin/bug-reports/${id}`, { data: {} })).status()).toBe(200);
  expect((await admin.get(`/api/admin/bug-reports/${id}`)).status()).toBe(404);
  const again = await (await admin.post('/__dev/cleanup', { data: { now: 2 * 24 * 3600 * 1000 } })).json();
  expect(again.ok).toBe(true);
  expect((await (await admin.get(`/api/admin/bug-reports?status=all&q=${id}`)).json()).total).toBe(0);
});

test('catalog requests count each pi-rust client once a day, by version and platform', async ({ playwright, baseURL }) => {
  const { client: admin } = await adminAccount(playwright, baseURL!);
  // Versions of this test's own, so other tests' catalog requests do not change these counts.
  const minor = Math.floor(Math.random() * 1_000_000);
  const [first, next] = [`7.${minor}.0`, `7.${minor}.1`];
  const ask = async (ip: string, userAgent: string, path = '/api/models/providers/anthropic', method = 'GET') => {
    const cli = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'CF-Connecting-IP': ip, 'User-Agent': userAgent } });
    await cli.fetch(path, { method });
  };
  const [a, b] = [testIp(), testIp()];
  await ask(a, `pi/${first} (linux; rust; x64)`);
  // The same client asking for another provider, and again after an update.
  await ask(a, `pi/${first} (linux; rust; x64)`, '/api/models/providers/openai');
  await ask(a, `pi/${next} (linux; rust; x64)`);
  await ask(b, `pi/${first} (darwin; rust; arm64)`);
  // Not counted: another method, another path, another client.
  await ask(testIp(), `pi/${first} (linux; rust; x64)`, '/api/models/providers/anthropic', 'HEAD');
  await ask(testIp(), `pi/${first} (linux; rust; x64)`, '/api/models/other');

  const users = async () => (await (await admin.get('/api/admin/versions')).json()).users;
  const userDays = (data: { versions: { version: string; userDays: number }[] }, version: string) => data.versions.find((row) => row.version === version)?.userDays;
  await expect.poll(async () => [userDays(await users(), first), userDays(await users(), next)]).toEqual([2, 1]);
  const data = await users();
  const today = new Date().toISOString().slice(0, 10);
  expect(data.todayVersions).toEqual(expect.arrayContaining([{ version: first, users: 2 }, { version: next, users: 1 }]));
  expect(data.today).toBeGreaterThanOrEqual(2);
  expect(data.since <= today).toBe(true);
  expect(data.days).toHaveLength(30);
  expect(data.days[29]).toEqual({ date: today, users: data.today });
});

test('a non-admin cannot reach any admin endpoint', async ({ playwright, baseURL }) => {
  const { client } = await verifiedAccount(playwright, baseURL!, uniqueEmail('plain'));
  for (const [method, path] of [
    ['GET', 'users'],
    ['GET', 'shares'],
    ['GET', 'bug-reports'],
    ['GET', 'activity'],
    ['GET', 'installs'],
    ['GET', 'versions'],
    ['POST', 'users/x/suspend'],
    ['DELETE', 'shares/x'],
  ]) {
    const response = await client.fetch(`/api/admin/${path}`, { method, data: method === 'GET' ? undefined : {} });
    expect(response.status(), `${method} ${path}`).toBe(403);
  }
  expect((await client.get('/api/admin/nothing')).status()).toBe(404);
});
