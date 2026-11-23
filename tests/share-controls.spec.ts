// Share controls: expiry, visibility, downloads, view counts, link previews, indexing, and cleanup.

import { test, expect, type APIRequestContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { accountClient, cliClient, cliToken, devState, pageIp, PASSWORD, testIp, verifiedAccount } from './helpers/accounts';

type Playwright = PlaywrightWorkerArgs['playwright'];
type Share = { id: string; url: string; title: string; size: number; createdAt: string; expiresAt: string | null; visibility: string; views: number; lastViewedAt: string | null };

const HTML_TYPE = { 'Content-Type': 'text/html; charset=utf-8' };
const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><h1>Shared</h1></body></html>';
const NO_INDEX = 'noindex, nofollow, noarchive, nosnippet, noimageindex';
const ROBOTS_META = '<meta name="robots" content="noindex, nofollow, noarchive">';
const HOUR = 3600;
const DAY = 24 * HOUR;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

// Each test runs in one browser project: the desktop one, or the phone one for tests tagged @phone.
test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== (testInfo.tags.includes('@phone') ? 'mobile' : 'desktop'), 'runs once'));

/** A verified account signed in with a cookie (`client`) and a pi CLI signed in to it (`cli`). */
async function owner(playwright: Playwright, baseURL: string) {
  const { client, email } = await verifiedAccount(playwright, baseURL);
  const cli = await cliClient(playwright, baseURL, await cliToken(playwright, baseURL, client));
  return { client, email, cli };
}

async function upload(cli: APIRequestContext, query = '', html = PAGE): Promise<Share> {
  const response = await cli.post(`/v1/shares${query}`, { headers: HTML_TYPE, data: html });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).share;
}

async function listed(cli: APIRequestContext, id: string): Promise<Share | undefined> {
  const { shares } = await (await cli.get('/v1/shares')).json();
  return (shares as Share[]).find((share) => share.id === id);
}

/** Signs the page's browser in, with its own client IP for the account API. */
async function signInPage(page: Page, baseURL: string, email: string): Promise<void> {
  await pageIp(page.context());
  const response = await page.request.post('/api/account/sign-in', { headers: { Origin: baseURL, 'CF-Connecting-IP': testIp() }, data: { email, password: PASSWORD } });
  expect(response.status()).toBe(200);
}

/** Within a few seconds of `seconds` from now. */
function expectExpiresIn(iso: string | null, seconds: number): void {
  expect(iso).toMatch(ISO);
  expect(Math.abs(Date.parse(iso!) - (Date.now() + seconds * 1000))).toBeLessThan(10_000);
}

test('uploads take an expiry and a visibility, and reject bad values', async ({ playwright, baseURL }) => {
  const { cli } = await owner(playwright, baseURL!);

  const plain = await upload(cli, '?title=Plain');
  expect(plain).toEqual({
    id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    url: `${baseURL}/s/${plain.id}`,
    title: 'Plain',
    size: Buffer.byteLength(PAGE),
    createdAt: expect.stringMatching(ISO),
    expiresAt: null,
    visibility: 'link',
    views: 0,
    lastViewedAt: null,
  });

  const hour = await upload(cli, `?title=Later&expires_in=${HOUR}&visibility=private`);
  expect(hour).toMatchObject({ title: 'Later', visibility: 'private', views: 0, lastViewedAt: null });
  expectExpiresIn(hour.expiresAt, HOUR);
  const year = await upload(cli, '?expires_in=31536000&visibility=link');
  expect(year.visibility).toBe('link');
  expectExpiresIn(year.expiresAt, 365 * DAY);
  expect(await listed(cli, hour.id)).toEqual(hour);

  for (const query of ['expires_in=3599', 'expires_in=31536001', 'expires_in=0', 'expires_in=-3600', 'expires_in=3600.5', 'expires_in=1e4', 'expires_in=', 'expires_in=never', 'visibility=public', 'visibility=PRIVATE', 'visibility=']) {
    const response = await cli.post(`/v1/shares?${query}`, { headers: HTML_TYPE, data: '<p>x</p>' });
    expect(response.status(), query).toBe(400);
    expect(await response.json(), query).toEqual({ ok: false, error: 'invalid_request', description: expect.any(String) });
  }
  expect((await (await cli.get('/v1/shares')).json()).shares).toHaveLength(3);
});

test('PATCH /v1/shares/<id> changes the title, expiry, and visibility, for the owner only', async ({ playwright, baseURL }) => {
  const { cli } = await owner(playwright, baseURL!);
  const share = await upload(cli, '?title=Draft');
  const patch = (client: APIRequestContext, data: unknown, id = share.id) => client.patch(`/v1/shares/${id}`, { data: data as Record<string, unknown> });

  const renamed = await patch(cli, { title: '  Final\tversion ' });
  expect(renamed.status()).toBe(200);
  expect(await renamed.json()).toEqual({ ok: true, share: { ...share, title: 'Final version' } });

  const day = (await (await patch(cli, { expiresIn: DAY })).json()).share;
  expectExpiresIn(day.expiresAt, DAY);
  expect(day).toMatchObject({ title: 'Final version', visibility: 'link' });

  const both = (await (await patch(cli, { expiresIn: null, visibility: 'private' })).json()).share;
  expect(both).toEqual({ ...share, title: 'Final version', expiresAt: null, visibility: 'private' });
  expect((await (await patch(cli, {})).json()).share).toEqual(both);
  expect(await listed(cli, share.id)).toEqual(both);

  for (const data of [{ expiresIn: 60 }, { expiresIn: 31536001 }, { expiresIn: 3600.5 }, { expiresIn: '3600' }, { visibility: 'public' }, { title: 42 }, { title: 'Changed', expiresIn: 1 }]) {
    const response = await patch(cli, data);
    expect(response.status(), JSON.stringify(data)).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'invalid_request', description: expect.any(String) });
  }
  // A rejected change writes nothing.
  expect((await listed(cli, share.id))!.title).toBe('Final version');

  const text = await cli.patch(`/v1/shares/${share.id}`, { headers: { 'Content-Type': 'text/plain' }, data: 'title=x' });
  expect(text.status()).toBe(415);
  const broken = await cli.patch(`/v1/shares/${share.id}`, { headers: { 'Content-Type': 'application/json' }, data: '{"title":' });
  expect(broken.status()).toBe(400);
  expect((await broken.json()).error).toBe('invalid_request');
  const list = await cli.patch(`/v1/shares/${share.id}`, { headers: { 'Content-Type': 'application/json' }, data: '[]' });
  expect(list.status()).toBe(400);

  const { cli: stranger } = await owner(playwright, baseURL!);
  const theirs = await patch(stranger, { title: 'Mine now' });
  expect(theirs.status()).toBe(404);
  expect(await theirs.json()).toEqual({ ok: false, error: 'not_found', description: expect.any(String) });
  expect((await patch(cli, { title: 'x' }, 'AAAAAAAAAAAAAAAAAAAAAA')).status()).toBe(404);
  const put = await cli.put(`/v1/shares/${share.id}`, { data: {} });
  expect(put.status()).toBe(405);
  expect(put.headers()['allow']).toBe('DELETE, PATCH');
  expect((await (await cliClient(playwright, baseURL!)).patch(`/v1/shares/${share.id}`, { data: { title: 'x' } })).status()).toBe(401);
});

/** Response headers without Date, which changes from one response to the next. */
function headersOf(response: { headers(): Record<string, string> }): Record<string, string> {
  const { date: _date, ...rest } = response.headers();
  return rest;
}

test('a private share is the same 404 as an unknown one to anyone but its signed-in owner', async ({ playwright, baseURL }) => {
  const { client, cli } = await owner(playwright, baseURL!);
  const share = await upload(cli, '?visibility=private&title=Secret');
  const expired = await upload(cli, `?visibility=private&expires_in=${HOUR}`);
  await devState(cli, { action: 'expire-share', id: expired.id });
  const signedOut = await accountClient(playwright, baseURL!);
  const { client: stranger } = await verifiedAccount(playwright, baseURL!);

  const unknownId = 'AAAAAAAAAAAAAAAAAAAAAA';
  const unknown = await signedOut.get(`/s/${unknownId}`);
  expect(unknown.status()).toBe(404);
  const unknownPage = await unknown.text();
  expect(unknownPage).toContain(`<a href="/account/sign-in/?next=/s/${unknownId}">Sign in</a>`);
  const unknownHead = headersOf(await signedOut.head(`/s/${unknownId}`));

  // Signed out, signed in as someone else, or with only a CLI token (not a browser session); live or
  // expired; the page or the download: the bytes differ from the unknown ID's 404 only by the ID.
  for (const [who, visitor] of [['signed out', signedOut], ['someone else', stranger], ['CLI token', cli]] as const) {
    for (const target of [share, expired]) {
      for (const path of [`/s/${target.id}`, `/s/${target.id}?download=1`]) {
        const response = await visitor.get(path, { maxRedirects: 0 });
        expect(response.status(), `${who} ${path}`).toBe(404);
        expect(headersOf(response), `${who} ${path}`).toEqual(headersOf(unknown));
        expect(await response.text(), `${who} ${path}`).toBe(unknownPage.replaceAll(unknownId, target.id));
      }
    }
    const head = await visitor.head(`/s/${share.id}`, { maxRedirects: 0 });
    expect(head.status(), who).toBe(404);
    expect(headersOf(head), who).toEqual(unknownHead);
  }

  // And byte for byte the 404 it gets once deleted.
  const doomed = await upload(cli, '?visibility=private');
  const hidden = await stranger.get(`/s/${doomed.id}`);
  expect((await cli.delete(`/v1/shares/${doomed.id}`)).status()).toBe(204);
  const deleted = await stranger.get(`/s/${doomed.id}`);
  expect(headersOf(hidden)).toEqual(headersOf(deleted));
  expect(await hidden.body()).toEqual(await deleted.body());

  // The owner sees it, with the robots tag and without a link preview.
  const view = await client.get(`/s/${share.id}`);
  expect(view.status()).toBe(200);
  const text = await view.text();
  expect(text).toBe(PAGE.replace('<head>', `<head>${ROBOTS_META}`));
  expect(text).not.toContain('og:');
  expect((await client.get(`/s/${share.id}?download=1`)).headers()['content-disposition']).toBe('attachment; filename="secret.html"');

  // Back to anyone with the link.
  expect((await cli.patch(`/v1/shares/${share.id}`, { data: { visibility: 'link' } })).status()).toBe(200);
  expect((await stranger.get(`/s/${share.id}`)).status()).toBe(200);
  expect((await signedOut.get(`/s/${share.id}`)).status()).toBe(200);
});

test('a signed-out owner signs in from the 404 page and comes back to the private share', async ({ page, playwright, baseURL }) => {
  const { email, cli } = await owner(playwright, baseURL!);
  const share = await upload(cli, '?visibility=private', '<!doctype html><html><head><title>Secret</title></head><body><h1>Only for me</h1></body></html>');
  await pageIp(page.context());

  const response = await page.goto(`/s/${share.id}`);
  expect(response!.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Share not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Sign in' }).click();
  // Waits for the load event too: the sign-in form does nothing until its script runs.
  await page.waitForURL(`${baseURL}/account/sign-in/?next=/s/${share.id}`);
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/s/${share.id}`);
  await expect(page.getByRole('heading', { name: 'Only for me' })).toBeVisible();

  // Signed in, the sign-in page sends the owner straight on, and only to a share or account path.
  const again = await page.request.get(`/account/sign-in/?next=/s/${share.id}`, { maxRedirects: 0 });
  expect(again.headers()['location']).toBe(`/s/${share.id}`);
  const elsewhere = await page.request.get('/account/sign-in/?next=%2Fs%2F..%2Faccount', { maxRedirects: 0 });
  expect(elsewhere.headers()['location']).toBe('/account/');
});

test('an expired share answers 410 once, then is gone', async ({ playwright, baseURL }) => {
  const { cli } = await owner(playwright, baseURL!);
  const share = await upload(cli, `?expires_in=${HOUR}`);
  const waiting = await upload(cli, `?expires_in=${HOUR}`);
  await devState(cli, { action: 'expire-share', id: share.id });
  await devState(cli, { action: 'expire-share', id: waiting.id });

  // Until the cleanup runs, the list shows an expired share with its past expiry.
  const stale = await listed(cli, waiting.id);
  expect(Date.parse(stale!.expiresAt!)).toBeLessThan(Date.now());

  const visitor = await accountClient(playwright, baseURL!);
  const gone = await visitor.get(`/s/${share.id}`);
  expect(gone.status()).toBe(410);
  expect(await gone.text()).toContain('This share expired.');
  expect(gone.headers()).toMatchObject({ 'x-robots-tag': NO_INDEX, 'cache-control': 'private, no-cache' });
  await expect.poll(async () => (await visitor.get(`/s/${share.id}`)).status()).toBe(404);
  expect(await listed(cli, share.id)).toBeUndefined();
  expect((await cli.delete(`/v1/shares/${share.id}`)).status()).toBe(404);
});

test('?download=1 sends the file as uploaded, named after the title', async ({ playwright, baseURL }) => {
  const { cli } = await owner(playwright, baseURL!);
  const share = await upload(cli, `?title=${encodeURIComponent('Café: "déjà vu" / v2!')}`);
  const visitor = await accountClient(playwright, baseURL!);
  const file = await visitor.get(`/s/${share.id}?download=1`);
  expect(file.status()).toBe(200);
  expect(file.headers()).toMatchObject({
    'content-disposition': 'attachment; filename="cafe-deja-vu-v2.html"',
    'content-type': 'text/html; charset=utf-8',
    'x-robots-tag': NO_INDEX,
  });
  expect(await file.text()).toBe(PAGE);

  const symbols = await upload(cli, `?title=${encodeURIComponent('★ ★ ★')}`);
  expect((await visitor.get(`/s/${symbols.id}?download=1`)).headers()['content-disposition']).toBe('attachment; filename="pi-session.html"');
});

test('views count everyone but the owner, link-preview bots, and HEAD requests', async ({ playwright, baseURL }) => {
  const { client, cli } = await owner(playwright, baseURL!);
  const share = await upload(cli);
  const path = `/s/${share.id}`;
  const visitor = await accountClient(playwright, baseURL!);

  expect((await client.get(path)).status()).toBe(200);
  expect((await client.get(`${path}?download=1`)).status()).toBe(200);
  for (const agent of [
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'Twitterbot/1.0',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'TelegramBot (like TwitterBot)',
    'WhatsApp/2.23.20.0',
  ]) {
    expect((await visitor.get(path, { headers: { 'User-Agent': agent } })).status(), agent).toBe(200);
  }
  expect((await visitor.head(path)).status()).toBe(200);

  expect((await visitor.get(path)).status()).toBe(200);
  await expect.poll(async () => (await listed(cli, share.id))!.views).toBe(1);
  expect((await listed(cli, share.id))!.lastViewedAt).toMatch(ISO);
  expect((await visitor.get(`${path}?download=1`)).status()).toBe(200);
  await expect.poll(async () => (await listed(cli, share.id))!.views).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect((await listed(cli, share.id))!.views).toBe(2);
});

test('shares are never indexed, and link shares get a link preview', async ({ playwright, baseURL, request }) => {
  const { cli } = await owner(playwright, baseURL!);
  const title = `Tom's "fix" <script>alert(1)</script> & more`;
  const share = await upload(cli, `?title=${encodeURIComponent(title)}`);
  const view = await request.get(`/s/${share.id}`);
  expect(view.headers()).toMatchObject({
    'content-security-policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
    'x-robots-tag': NO_INDEX,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-cache',
  });
  const tags = [
    ROBOTS_META,
    '<meta property="og:title" content="Tom&#39;s &quot;fix&quot; &lt;script&gt;alert(1)&lt;/script&gt; &amp; more">',
    '<meta property="og:description" content="A pi session shared on pi-rust.com">',
    '<meta property="og:site_name" content="pi-rust">',
    '<meta property="og:type" content="article">',
    '<meta name="twitter:card" content="summary">',
  ].join('');
  expect(await view.text()).toBe(PAGE.replace('<head>', `<head>${tags}`));

  // A page without a <head> tag gets them where the parser still puts them in the head.
  const bare = await upload(cli, '?title=Bare', '<!doctype html><title>t</title><h1>Shared</h1>');
  expect(await (await request.get(`/s/${bare.id}`)).text()).toMatch(/^<!doctype html><meta name="robots" content="noindex, nofollow, noarchive"><meta property="og:title" content="Bare">.*<title>t<\/title><h1>Shared<\/h1>$/);

  for (const [path, status] of [
    ['/s/AAAAAAAAAAAAAAAAAAAAAA', 404],
    ['/s/not-an-id', 404],
    ['/s/', 404],
    ['/session/', 200],
    ['/session', 302],
  ] as const) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(status);
    expect(response.headers()['x-robots-tag'], path).toBe(NO_INDEX);
  }
  expect(await (await request.get('/s/AAAAAAAAAAAAAAAAAAAAAA')).text()).toContain(ROBOTS_META);
  expect(await (await request.get('/s/not-an-id')).text()).toContain('<a href="/account/sign-in/">Sign in</a>');
  const post = await request.post(`/s/${share.id}`, { data: {} });
  expect(post.status()).toBe(405);
  expect(post.headers()['x-robots-tag']).toBe(NO_INDEX);

  // Search engines may fetch /s/ to read the noindex; AI crawlers are asked to stay out.
  const robots = await (await request.get('/robots.txt')).text();
  const groups = robots.split(/\n\s*\n/).filter((group) => group.startsWith('User-agent:'));
  expect(groups.length).toBeGreaterThan(10);
  for (const group of groups) {
    const agent = group.match(/^User-agent: (\S+)/)![1];
    if (agent === '*') expect(group, agent).not.toContain('Disallow');
    else {
      expect(group, agent).toContain('Disallow: /s/\n');
      expect(group, agent).toMatch(/Disallow: \/session\/(\n|$)/);
    }
  }
});

test('the hourly cleanup deletes expired shares and old sign-in rows', async ({ playwright, baseURL }) => {
  const { cli, email } = await owner(playwright, baseURL!);
  const asOf = 2 * DAY * 1000;
  // Runs as of 2 days after 1970, so it only reaches rows this test dates back to 1970; other tests' rows stay.
  const run = async () => (await (await cli.post('/__dev/cleanup', { data: { now: asOf } })).json()).deleted;
  await run();

  const first = await upload(cli, `?expires_in=${HOUR}`);
  const second = await upload(cli, `?expires_in=${HOUR}&visibility=private`);
  const lasting = await upload(cli);
  for (const share of [first, second]) await devState(cli, { action: 'expire-share', id: share.id, at: 1 });
  const grant = await (await (await cliClient(playwright, baseURL!)).post('/oauth/device_authorization', { form: { client_id: 'pi-cli', scope: 'share' } })).json();
  await devState(cli, { action: 'expire-device-code', userCode: grant.user_code, at: 1 });
  await devState(cli, { action: 'expire-email-tokens', email, at: 1 });

  // /oauth/device_authorization also deletes device codes a day past expiry, so a test running beside
  // this one may delete the dated code first. Either way it is gone.
  const deleted = await run();
  // A bug report uploaded by a test beside this one may be indexed by this run before its own row is written.
  expect(deleted).toEqual({ shares: 2, deviceCodes: expect.any(Number), signInChallenges: 0, emailTokens: 1, webauthnChallenges: 0, bugReports: 0, bugReportsIndexed: expect.any(Number), adminEvents: 0, catalogSalts: 0, catalogClients: 0, emailChanges: 0, githubStates: 0 });
  expect(deleted.deviceCodes).toBeLessThanOrEqual(1);
  const poll = await (await cliClient(playwright, baseURL!)).post('/oauth/token', {
    form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: grant.device_code, client_id: 'pi-cli' },
  });
  expect((await poll.json()).error).toBe('invalid_grant');
  const { shares } = await (await cli.get('/v1/shares')).json();
  expect(shares.map((share: Share) => share.id)).toEqual([lasting.id]);
  expect((await cli.get(`/s/${first.id}`)).status()).toBe(404);
  expect((await cli.get(`/s/${lasting.id}`)).status()).toBe(200);
  expect(await run()).toEqual({ shares: 0, deviceCodes: 0, signInChallenges: 0, emailTokens: 0, webauthnChallenges: 0, bugReports: 0, bugReportsIndexed: expect.any(Number), adminEvents: 0, catalogSalts: 0, catalogClients: 0, emailChanges: 0, githubStates: 0 });
});

test('the Shares page API: change a share, delete the expired ones, delete them all', async ({ playwright, baseURL }) => {
  const { client, email, cli } = await owner(playwright, baseURL!);
  const [first, second, third] = [await upload(cli), await upload(cli), await upload(cli, `?expires_in=${HOUR}`)];
  await devState(cli, { action: 'expire-share', id: third.id });

  const patched = await client.patch(`/api/account/shares/${first.id}`, { data: { title: 'From the page', visibility: 'private', expiresIn: 7 * DAY } });
  expect(patched.status()).toBe(200);
  const { share } = await patched.json();
  expect(share).toMatchObject({ id: first.id, title: 'From the page', visibility: 'private' });
  expectExpiresIn(share.expiresAt, 7 * DAY);
  const bad = await client.patch(`/api/account/shares/${first.id}`, { data: { expiresIn: 5 } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toBe('invalid_request');
  expect((await client.patch('/api/account/shares/AAAAAAAAAAAAAAAAAAAAAA', { data: { title: 'x' } })).status()).toBe(404);
  const crossSite = await client.patch(`/api/account/shares/${first.id}`, { headers: { Origin: 'https://example.com' }, data: { title: 'x' } });
  expect(crossSite.status()).toBe(403);
  expect((await (await cliClient(playwright, baseURL!)).post('/api/account/shares/delete-all', { headers: { Origin: baseURL! }, data: {} })).status()).toBe(401);

  expect(await (await client.post('/api/account/shares/delete-expired', { data: {} })).json()).toEqual({ ok: true, deleted: 1 });
  expect(await (await client.post('/api/account/shares/delete-expired', { data: {} })).json()).toEqual({ ok: true, deleted: 0 });

  // Deleting every share needs a confirmation from the last 10 minutes.
  await devState(client, { action: 'age-reauth', email });
  const stale = await client.post('/api/account/shares/delete-all', { data: {} });
  expect(stale.status()).toBe(403);
  expect((await stale.json()).error).toBe('reauth_required');
  expect((await client.post('/api/account/reauth', { data: { password: PASSWORD } })).status()).toBe(200);
  expect(await (await client.post('/api/account/shares/delete-all', { data: {} })).json()).toEqual({ ok: true, deleted: 2 });
  expect((await (await client.get('/api/account/shares')).json()).shares).toEqual([]);
  for (const id of [first.id, second.id, third.id]) expect((await cli.get(`/s/${id}`)).status()).toBe(404);
});

test('the Shares page renames a share, sets its expiry and visibility, and deletes shares', async ({ page, playwright, baseURL }) => {
  const { email, cli } = await owner(playwright, baseURL!);
  const first = await upload(cli, '?title=Parser%20fix');
  await upload(cli, '?title=Notes');
  await upload(cli, '?title=Benchmarks');
  const old = await upload(cli, `?title=Old%20session&expires_in=${HOUR}`);
  await devState(cli, { action: 'expire-share', id: old.id });
  await (await accountClient(playwright, baseURL!)).get(`/s/${first.id}`);
  await expect.poll(async () => (await listed(cli, first.id))!.views).toBe(1);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signInPage(page, baseURL!, email);

  await page.goto('/account/');
  const rows = page.locator('[data-shares] li');
  const rowOf = (title: string) => rows.filter({ has: page.getByRole('link', { name: title, exact: true }) });
  await expect(rows).toHaveCount(4);
  await expect(page.locator('[data-shares-count]')).toHaveText('4 shares');
  await expect(rowOf('Parser fix')).toContainText('1 view · last viewed just now');
  await expect(rowOf('Notes')).toContainText('No views yet');
  await expect(page.getByRole('link', { name: 'Open Parser fix' })).toHaveAttribute('href', first.url);
  await expect(page.getByRole('link', { name: 'Download Parser fix' })).toHaveAttribute('href', `${first.url}?download=1`);
  // An expired share keeps only its menu.
  await expect(rowOf('Old session').locator('.badge')).toHaveText('Expired');
  await expect(page.getByRole('button', { name: 'Copy link to Old session' })).toHaveCount(0);

  // The menu works from the keyboard: it opens on the first item, and Escape returns to its button.
  const more = page.getByRole('button', { name: 'More actions for Parser fix' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: 'Never' })).toBeFocused();
  await expect(page.getByRole('menuitemradio', { name: 'Never' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemradio', { name: 'Anyone with the link' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  await more.click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename share' });
  await expect(rename.getByLabel('Title')).toHaveValue('Parser fix');
  await rename.getByLabel('Title').fill('Parser fix, part 2');
  await rename.getByRole('button', { name: 'Save' }).click();
  const renamed = rowOf('Parser fix, part 2');
  await expect(renamed).toBeVisible();

  await page.getByRole('button', { name: 'More actions for Parser fix, part 2' }).click();
  await page.getByRole('menuitemradio', { name: '1 day' }).click();
  await expect(renamed).toContainText('Expires in 1 day');
  await page.getByRole('button', { name: 'More actions for Parser fix, part 2' }).click();
  await page.getByRole('menuitemradio', { name: 'Only me' }).click();
  await expect(renamed.locator('.badge')).toHaveText('Only me');
  await page.getByRole('button', { name: 'More actions for Parser fix, part 2' }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Only me' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemradio', { name: 'Never' }).click();
  await expect(renamed).not.toContainText('Expires in');
  expect(await listed(cli, first.id)).toMatchObject({ title: 'Parser fix, part 2', visibility: 'private', expiresAt: null });

  await page.getByRole('button', { name: 'More actions for Notes' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete share?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(rows).toHaveCount(3);

  await page.getByRole('button', { name: 'Delete expired' }).click();
  await page.getByRole('dialog', { name: 'Delete 1 expired share?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Delete expired' })).toBeHidden();

  // Deleting every share asks for the password when the last confirmation is old.
  await devState(cli, { action: 'age-reauth', email });
  await page.getByRole('button', { name: 'Delete all shares' }).click();
  await page.getByRole('dialog', { name: 'Delete all 2 shares?' }).getByRole('button', { name: 'Delete all' }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await confirm.getByLabel('Password').fill(PASSWORD);
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('No shared sessions.')).toBeVisible();
  await expect(page.locator('[data-shares-foot]')).toBeHidden();
  expect((await (await cli.get('/v1/shares')).json()).shares).toEqual([]);
  expect(errors).toEqual([]);
});

test('the Shares page and its menu fit a phone screen', { tag: '@phone' }, async ({ page, playwright, baseURL }) => {
  const { email, cli } = await owner(playwright, baseURL!);
  await upload(cli, `?title=${encodeURIComponent('A very long title for a shared session that goes on and on about the tokenizer')}&visibility=private&expires_in=${7 * DAY}`);
  await upload(cli, '?title=Short');
  await signInPage(page, baseURL!, email);
  await page.goto('/account/');
  await expect(page.locator('[data-shares] li')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: /^More actions for A very long title/ }).click();
  const box = (await page.getByRole('menu').boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
});
