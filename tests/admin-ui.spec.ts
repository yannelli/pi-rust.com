// The admin pages in a browser: the gate, the overview, suspending and restoring from People, a bug
// report's details, and the phone layout.

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { adminAccount, devState, pageIp, testIp, verifiedAccount } from './helpers/accounts';

// Each test runs in one browser project: the desktop one, or the phone one for tests tagged @phone.
test.beforeEach(async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== (testInfo.tags.includes('@phone') ? 'mobile' : 'desktop'), 'runs once');
  await pageIp(context);
});

/** Signs the page's browser in with the API client's session cookie. */
async function signInAs(page: Page, client: APIRequestContext): Promise<void> {
  await page.context().addCookies((await client.storageState()).cookies);
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('the admin area is a 404 to other accounts and asks an admin for two-step verification', async ({ page, playwright, baseURL }) => {
  const { client, email } = await verifiedAccount(playwright, baseURL!);
  await signInAs(page, client);
  const response = await page.goto('/admin/');
  expect(response?.status()).toBe(404);
  await page.goto('/account/');
  await expect(page.locator('[data-account-email]')).toHaveText(email);
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toBeHidden();

  await devState(client, { action: 'make-admin', email });
  await page.reload();
  await page.getByRole('link', { name: 'Admin', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/$/);
  await expect(page.getByRole('heading', { name: 'Turn on two-step verification' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Security' })).toHaveAttribute('href', '/account/security/');
  await expect(page.locator('[data-admin-content]')).toBeHidden();
});

test('the overview shows totals and charts', async ({ page, playwright, baseURL }) => {
  const errors = trackErrors(page);
  const { client, email } = await adminAccount(playwright, baseURL!);
  await signInAs(page, client);
  await page.goto('/admin/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(page.locator('[data-admin-avatar]')).toHaveText(email.slice(0, 1));
  await expect(page.locator('[data-stat="accounts"]')).toHaveText(/^\d[\d,]*$/);
  await expect(page.getByRole('img', { name: /^New accounts: [\d,]+ in the last 30 days$/ })).toBeVisible();
  await expect(page.getByRole('img', { name: /^New shares: / })).toBeVisible();
  await expect(page.getByText('Install stats are not set up')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'pi-rust in use' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  expect(errors).toEqual([]);
});

test('the overview shows pi-rust users per day and the shares of their versions', async ({ page, playwright, baseURL, request }) => {
  const errors = trackErrors(page);
  const { client } = await adminAccount(playwright, baseURL!);
  await signInAs(page, client);
  const { version: latest } = await (await request.get('/version.json')).json();
  // Other tests count clients in the same local database, so the page gets the Worker's answer from a fixture.
  const counts: Record<number, number> = { 27: 10, 28: 20, 29: 8 };
  const days = Array.from({ length: 30 }, (_, index) => ({ date: new Date(Date.now() - (29 - index) * 86_400_000).toISOString().slice(0, 10), users: counts[index] ?? 0 }));
  await page.route('**/api/admin/versions', (route) =>
    route.fulfill({
      json: {
        ok: true,
        users: {
          today: 8,
          since: days[27].date,
          days,
          versions: [
            { version: latest, userDays: 30 },
            { version: '0.12.1', userDays: 9 },
            { version: 'unknown', userDays: 1 },
          ],
          platforms: [
            { platform: 'darwin', arch: 'arm64', userDays: 30 },
            { platform: 'linux', arch: 'x64', userDays: 10 },
          ],
          todayVersions: [
            { version: latest, users: 6 },
            { version: '0.12.1', users: 2 },
          ],
        },
        requests: { configured: false },
      },
    }),
  );
  await page.goto('/admin/');
  const section = page.locator('#versions');
  await expect(section.getByRole('heading', { name: 'pi-rust in use' })).toBeVisible();
  const figure = (label: string) => section.locator('.figure').filter({ has: page.locator('.stat__label', { hasText: label }) });
  await expect(figure('Users today')).toContainText('8So far, in UTC');
  // Today is not over, so the average is over the two full days.
  await expect(figure('Users per day')).toContainText('15Average of 2 days');
  await expect(figure('On the latest release')).toContainText(`75%Of users today, on ${latest}`);
  await expect(figure('Catalog requests')).toContainText('–Needs the analytics token');
  await expect(section.getByRole('img', { name: 'Users per day: 38 in the last 30 days' })).toBeVisible();
  const latestRow = section.locator('.meter').filter({ hasText: latest });
  await expect(latestRow).toContainText('Latest');
  await expect(latestRow.locator('.meter__value')).toHaveText('75%');
  await expect(section.locator('.meter').filter({ hasText: '0.12.1' }).locator('.meter__value')).toHaveText('23%');
  await expect(section.locator('.meter').filter({ hasText: 'unknown' }).locator('.meter__value')).toHaveText('2.5%');
  await expect(section.locator('.meter').filter({ hasText: 'darwin arm64' }).locator('.meter__value')).toHaveText('75%');
  await expect(section.locator('.meter__count')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('suspend and restore an account from People', async ({ page, playwright, baseURL }) => {
  const errors = trackErrors(page);
  const { client } = await adminAccount(playwright, baseURL!);
  const { email } = await verifiedAccount(playwright, baseURL!);
  await signInAs(page, client);

  await page.goto('/admin/');
  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'People' }).click();
  await expect(page.getByRole('heading', { name: 'People', level: 1 })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search accounts by email' }).fill(email);
  const row = page.getByRole('listitem').filter({ hasText: email });
  await expect(row).toHaveCount(1);
  await expect(page.locator('[data-count]')).toHaveText('1 account');
  // The search is kept in the address.
  await expect(page).toHaveURL(new RegExp(`\\?q=${encodeURIComponent(email).replace(/\./g, '\\.')}$`));

  await row.getByRole('button', { name: `Actions for ${email}` }).click();
  await page.getByRole('menuitem', { name: 'Suspend account…' }).click();
  const dialog = page.getByRole('dialog', { name: `Suspend ${email}?` });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Reason').fill('Spam');
  await dialog.getByRole('button', { name: 'Suspend' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Account suspended' })).toBeVisible();
  await expect(row.getByText('Suspended', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Suspended', exact: true }).click();
  await expect(page).toHaveURL(/filter=suspended/);
  await expect(row).toHaveCount(1);

  await row.getByRole('button', { name: `Actions for ${email}` }).click();
  await page.getByRole('menuitem', { name: 'Restore account' }).click();
  await page.getByRole('dialog', { name: `Restore ${email}?` }).getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Account restored' })).toBeVisible();
  await expect(page.getByText('No matching accounts')).toBeVisible();

  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Activity' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: `suspended ${email}` }).first()).toContainText('Reason: Spam');
  expect(errors).toEqual([]);
});

test('read and close a bug report', async ({ page, playwright, baseURL, request }) => {
  const errors = trackErrors(page);
  const { client } = await adminAccount(playwright, baseURL!);
  const id = crypto.randomUUID();
  const report = { id, hint: `Status line is blank ${id.slice(0, 8)}\nIt happens after /model.`, environment: { version: '0.12.30', platform: 'darwin', arch: 'arm64' } };
  const upload = await request.post('/v1/bug-reports', {
    // A client IP of its own: the bug report limiter allows 5 a minute per IP.
    headers: { 'CF-Connecting-IP': testIp() },
    multipart: {
      'report.json': { name: 'report.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report)) },
      'diagnostics.json': { name: 'diagnostics.json', mimeType: 'application/json', buffer: Buffer.from('{"assistant":[],"crashes":[]}') },
    },
  });
  expect(upload.status()).toBe(201);
  await signInAs(page, client);

  await page.goto(`/admin/bug-reports/?q=${id}`);
  await expect(page.getByRole('searchbox', { name: 'Search bug reports' })).toHaveValue(id);
  await page.getByRole('button', { name: `Status line is blank ${id.slice(0, 8)}` }).click();
  const dialog = page.getByRole('dialog', { name: `Status line is blank ${id.slice(0, 8)}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-report-text]')).toHaveText(report.hint);
  await expect(dialog.getByText('darwin arm64')).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Download report.json' })).toHaveAttribute('href', `/api/admin/bug-reports/${id}/files/report.json`);
  await dialog.getByRole('button', { name: 'Close report' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Report closed' })).toBeVisible();
  await expect(page.getByText('No matching reports')).toBeVisible();

  await page.getByRole('button', { name: 'Closed', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: `Status line is blank ${id.slice(0, 8)}` }).getByText('Closed')).toBeVisible();
  expect(errors).toEqual([]);
});

test('on a phone, the admin sections scroll in one row and the page does not', { tag: '@phone' }, async ({ page, playwright, baseURL }) => {
  const errors = trackErrors(page);
  const { client } = await adminAccount(playwright, baseURL!);
  await signInAs(page, client);
  await page.goto('/admin/bug-reports/');
  await expect(page.getByRole('heading', { name: 'Bug reports', level: 1 })).toBeVisible();
  const current = page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Bug reports' });
  await expect(current).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto('/admin/');
  await expect(page.locator('[data-stat="accounts"]')).toHaveText(/^\d/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
