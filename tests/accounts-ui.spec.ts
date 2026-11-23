import { test, expect, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { accountClient, cliClient, createVerified, devState, linkIn, mailbox, pageIp, PASSWORD, totp, uniqueEmail, waitForMail } from './helpers/accounts';

/** A verified account, signed in in this page's browser context. */
async function signedIn(page: Page, baseURL: string, playwright: PlaywrightWorkerArgs['playwright']): Promise<string> {
  const email = uniqueEmail('ui');
  await createVerified(await accountClient(playwright, baseURL), email);
  const response = await page.request.post('/api/account/sign-in', { headers: { Origin: baseURL }, data: { email, password: PASSWORD } });
  expect(response.status()).toBe(200);
  return email;
}

async function signInWithPassword(page: Page, email: string): Promise<void> {
  await page.goto('/account/sign-in/');
  await fillSignIn(page, email);
}

/** Fills the sign-in page the browser is on: email, Next, password, Sign in. */
async function fillSignIn(page: Page, email: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function signOut(page: Page): Promise<void> {
  // The page script has run once it shows the address.
  await expect(page.locator('[data-account-email]')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
  await page.waitForURL(/\/account\/sign-in\/\?signedout=1$/);
}

test.describe('account pages', () => {
  test.beforeEach(async ({ context }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'flows run once; the phone layout has its own test');
    await pageIp(context);
  });

  test('sign up, verify, sign in, and sign out', async ({ page, playwright, baseURL }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const email = uniqueEmail('pages');

    await page.goto('/account/sign-up/');
    await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Enter your email.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Email' })).toHaveAttribute('aria-invalid', 'true');
    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByRole('textbox', { name: 'Email' }).press('Enter');
    await expect(page.getByRole('heading', { name: 'Create a password' })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
    await page.getByLabel('Password', { exact: true }).fill('too short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Use at least 10 characters.')).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('checkbox', { name: /I agree to the Terms of Service/ }).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.locator('[data-sent-to]')).toHaveText(email);

    const mail = await waitForMail(await accountClient(playwright, baseURL!), email, /Verify your email/);
    await page.goto(linkIn(mail, /\/account\/verify\//));
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    // The token leaves the address bar once it is read.
    expect(new URL(page.url()).hash).toBe('');
    await page.getByRole('link', { name: 'Continue' }).click();
    await page.waitForURL(/\/account\/sign-in\/$/);
    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('button', { name: 'Change email' })).toHaveText(email);
    await page.getByLabel('Password', { exact: true }).fill('not my password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Wrong email or password.')).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page).toHaveURL(/\/account\/$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Shares' })).toBeVisible();
    await expect(page.locator('[data-account-email]')).toHaveText(email);
    await expect(page.getByText('No shared sessions.')).toBeVisible();
    await page.getByRole('link', { name: 'Security' }).click();
    await expect(page.getByText('This browser')).toBeVisible();
    await signOut(page);
    await expect(page.getByText('You signed out.')).toBeVisible();
    await page.goto('/account/');
    await expect(page).toHaveURL(/\/account\/sign-in\/\?next=%2Faccount%2F$/);
    expect(errors).toEqual([]);
  });

  test('sign-up asks for the Terms box and sends nothing without it', async ({ page, playwright, baseURL }) => {
    const email = uniqueEmail('terms-ui');
    const signUps: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/account/sign-up')) signUps.push(request.url());
    });
    await page.goto('/account/sign-up/');
    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    const terms = page.getByRole('checkbox', { name: /I agree to the Terms of Service/ });
    await expect(terms).not.toBeChecked();
    await expect(page.getByRole('link', { name: 'Terms of Service', exact: true })).toHaveAttribute('target', '_blank');
    await expect(page.getByRole('link', { name: 'Privacy Policy', exact: true })).toHaveAttribute('target', '_blank');

    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Confirm that you are 18 or older and agree to the Terms of Service.')).toBeVisible();
    await expect(terms).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('heading', { name: 'Create a password' })).toBeVisible();
    expect(signUps).toEqual([]);
    expect(await mailbox(await accountClient(playwright, baseURL!), email)).toEqual([]);
  });

  test('reset the password from the email link', async ({ page, playwright, baseURL }) => {
    const email = uniqueEmail('reset');
    const api = await accountClient(playwright, baseURL!);
    await createVerified(api, email);
    await page.goto('/account/sign-in/');
    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await page.waitForURL('**/account/reset/');
    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByRole('button', { name: 'Send link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    const mail = await waitForMail(api, email, /Reset your pi-rust password/);
    await page.goto(linkIn(mail, /\/account\/new-password\//));
    await page.getByLabel('New password').fill('my new password 42');
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByText('Your password was changed. Sign in with the new password.')).toBeVisible();
  });

  test('turn on two-step verification, then sign in with a code and with a recovery code', async ({ page, playwright, baseURL }) => {
    const email = await signedIn(page, baseURL!, playwright);
    await page.goto('/account/security/');
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.locator('[data-totp-qr] svg')).toBeVisible();
    const secret = (await page.locator('[data-totp-secret]').textContent())!.replace(/\s/g, '');
    await page.getByRole('textbox', { name: 'Code' }).fill(totp(secret));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.locator('[data-totp-badge]')).toHaveText('On');
    const codes = await page.locator('[data-codes-list] li').allTextContents();
    expect(codes).toHaveLength(10);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('10 of 10 codes left.')).toBeVisible();

    await signOut(page);
    await signInWithPassword(page, email);
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Code' }).fill(totp(secret, 1));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/account\/$/);

    await signOut(page);
    await signInWithPassword(page, email);
    await page.getByRole('button', { name: 'Try another way' }).first().click();
    await expect(page.getByRole('button', { name: 'Use your passkey' })).toBeHidden();
    await page.getByRole('button', { name: 'Enter a recovery code' }).click();
    await page.getByLabel('Recovery code').fill(codes[3]);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/account\/$/);
  });

  test('add a passkey, then sign in with it alone', async ({ page, playwright, baseURL }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    const email = await signedIn(page, baseURL!, playwright);

    await page.goto('/account/security/');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.locator('[data-passkeys] li')).toHaveCount(1);
    await expect(page.locator('[data-passkeys]')).toContainText('Passkey on');
    // The first second step comes with recovery codes.
    await expect(page.locator('[data-codes-list] li')).toHaveCount(10);
    await page.getByRole('button', { name: 'Done' }).click();
    await waitForMail(await accountClient(playwright, baseURL!), email, /passkey was added/);

    await page.getByRole('button', { name: /^Rename / }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Work laptop');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-passkeys]')).toContainText('Work laptop');

    // Passwordless sign-in.
    await signOut(page);
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page).toHaveURL(/\/account\/$/);
    await expect(page.locator('[data-account-email]')).toHaveText(email);

    // With a passkey, a password sign-in needs it as the second step.
    await signOut(page);
    await signInWithPassword(page, email);
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    await page.getByRole('button', { name: 'Use passkey' }).click();
    await expect(page).toHaveURL(/\/account\/$/);

    // An old confirmation asks again before a sensitive action.
    await devState(await accountClient(playwright, baseURL!), { action: 'age-reauth', email });
    await page.goto('/account/security/');
    await page.getByRole('button', { name: 'Remove Work laptop' }).click();
    await page.getByRole('dialog', { name: 'Remove passkey?' }).getByRole('button', { name: 'Remove' }).click();
    const confirm = page.getByRole('dialog', { name: 'Confirm it’s you' });
    await expect(confirm).toBeVisible();
    await confirm.getByLabel('Password').fill('wrong password!');
    await confirm.getByRole('button', { name: 'Confirm' }).click();
    await expect(confirm.getByText('Wrong password.')).toBeVisible();
    await confirm.getByLabel('Password').fill(PASSWORD);
    await confirm.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('No passkeys.')).toBeVisible();
  });

  test('the device page approves a pi CLI sign-in after signing in', async ({ page, playwright, baseURL }) => {
    const email = uniqueEmail('device');
    await createVerified(await accountClient(playwright, baseURL!), email);
    const cli = await cliClient(playwright, baseURL!);
    const grant = await (await cli.post('/oauth/device_authorization', { form: { client_id: 'pi-cli', scope: 'share' } })).json();

    await page.goto(grant.verification_uri_complete);
    await expect(page).toHaveURL(/\/account\/sign-in\/\?next=/);
    await fillSignIn(page, email);
    await expect(page).toHaveURL(new RegExp(`/device/\\?user_code=${grant.user_code}$`));
    await expect(page.locator('[data-code-shown]')).toHaveText(grant.user_code);
    await expect(page.locator('[data-client]')).toHaveText('pi 0.12.26 on Linux');
    await expect(page.locator('[data-account]')).toHaveText(email);
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('heading', { name: 'pi CLI connected' })).toBeVisible();

    const token = await cli.post('/oauth/token', {
      form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: grant.device_code, client_id: 'pi-cli' },
    });
    expect((await token.json()).account).toEqual({ email });

    // Typing a code by hand, and denying.
    const second = await (await cli.post('/oauth/device_authorization', { form: { client_id: 'pi-cli', scope: 'share' } })).json();
    await page.goto('/device/');
    await page.getByRole('textbox', { name: 'Code' }).fill(second.user_code.replace('-', '').toLowerCase());
    await expect(page.getByRole('textbox', { name: 'Code' })).toHaveValue(second.user_code);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect(page.getByRole('heading', { name: 'Request denied' })).toBeVisible();
  });
});

test.describe('account page headers and indexing', () => {
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'once is enough'));

  test('account pages are noindex, outside the sitemap, and send a strict CSP', async ({ request, page }) => {
    for (const path of ['/account/sign-in/', '/account/sign-up/', '/account/reset/', '/account/new-password/', '/account/verify/']) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      const headers = response.headers();
      expect(headers['content-security-policy'], path).toContain("script-src 'self' 'wasm-unsafe-eval'");
      expect(headers['content-security-policy'], path).toContain("frame-ancestors 'none'");
      expect(headers['content-security-policy'].match(/script-src [^;]*/)![0], path).not.toContain('unsafe-inline');
      expect(headers).toMatchObject({ 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
      const html = await response.text();
      expect(html, path).toContain('<meta name="robots" content="noindex, follow">');
      // No inline script runs on these pages; JSON-LD is data.
      expect(html.match(/<script(?![^>]*(type="application\/ld\+json"|src=))[^>]*>/g), path).toBeNull();
    }
    const index = await (await request.get('/sitemap-index.xml')).text();
    const child = index.match(/https:\/\/pi-rust\.com\/(sitemap-\d+\.xml)/)![1];
    expect(await (await request.get(`/${child}`)).text()).not.toMatch(/\/(account|device|session)\//);

    // A signed-out visit to a signed-in page goes to sign-in and comes back after.
    const redirect = await request.get('/account/security/', { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    expect(redirect.headers()['location']).toBe('/account/sign-in/?next=%2Faccount%2Fsecurity%2F');
    const device = await request.get('/device?user_code=BCDF-GHJK', { maxRedirects: 0 });
    expect(device.headers()['location']).toBe('/device/?user_code=BCDF-GHJK');

    // The pages run under that CSP without errors.
    const violations: string[] = [];
    page.on('console', (message) => message.type() === 'error' && violations.push(message.text()));
    await page.goto('/account/sign-in/');
    await page.getByRole('button', { name: 'Search docs' }).click();
    await page.getByRole('combobox').fill('rpc');
    await expect(page.getByRole('option').first()).toBeVisible();
    expect(violations).toEqual([]);
  });
});

test.describe('session viewer', () => {
  const GIST = '0123456789abcdef0123456789abcdef';

  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'once is enough'));

  test('shows the first HTML file of a gist in a sandboxed frame', async ({ page }) => {
    const html = '<!doctype html><h1>Session export</h1>';
    await page.route(`https://api.github.com/gists/${GIST}`, (route) =>
      route.fulfill({
        json: {
          html_url: `https://gist.github.com/someone/${GIST}`,
          description: 'Fix the parser',
          files: {
            'notes.md': { filename: 'notes.md', raw_url: 'https://gist.githubusercontent.com/x/notes.md', content: '# notes' },
            'session.html': { filename: 'session.html', raw_url: 'https://gist.githubusercontent.com/x/session.html', truncated: true, content: '<h1>cut' },
          },
        },
        headers: { 'Access-Control-Allow-Origin': '*' },
      }),
    );
    await page.route('https://gist.githubusercontent.com/x/session.html', (route) =>
      route.fulfill({ body: html, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' } }),
    );
    const response = await page.goto(`/session/#${GIST}`);
    expect(response!.headers()['content-security-policy']).toBe("frame-ancestors 'none'");
    const frame = page.locator('iframe[data-frame]');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    await expect(page.frameLocator('iframe[data-frame]').getByRole('heading', { name: 'Session export' })).toBeVisible();
    await expect(page.locator('[data-title]')).toHaveText('Fix the parser');
    await expect(page.getByRole('link', { name: 'View gist' })).toHaveAttribute('href', `https://gist.github.com/someone/${GIST}`);
    await expect(page.locator('footer a[href="https://ryanyannelli.com/"]').first()).toBeAttached();
  });

  test('explains a missing gist, a rate limit, and a bad link', async ({ page }) => {
    await page.route('https://api.github.com/gists/**', (route) =>
      route.request().url().endsWith('/missing')
        ? route.fulfill({ status: 404, json: { message: 'Not Found' }, headers: { 'Access-Control-Allow-Origin': '*' } })
        : route.fulfill({
            status: 403,
            json: { message: 'API rate limit exceeded' },
            headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'x-ratelimit-remaining, x-ratelimit-reset', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' },
          }),
    );
    await page.goto('/session/#missing');
    await expect(page.getByRole('heading', { name: 'Session not found' })).toBeVisible();
    await page.goto('/session/#limited');
    await expect(page.getByRole('heading', { name: 'GitHub rate limit reached' })).toBeVisible();
    await page.goto('/session/');
    await expect(page.getByRole('heading', { name: 'No session here' })).toBeVisible();
    await expect(page.locator('iframe[data-frame]')).toBeHidden();
  });
});

test('account pages fit a phone screen', async ({ page, context, playwright, baseURL }) => {
  test.skip(test.info().project.name !== 'mobile', 'phone layout only');
  await pageIp(context);
  for (const path of ['/account/sign-in/', '/account/sign-up/', '/account/reset/']) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), path).toBeLessThanOrEqual(0);
  }
  await signedIn(page, baseURL!, playwright);
  for (const path of ['/account/', '/account/security/', '/account/settings/', '/device/']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), path).toBeLessThanOrEqual(0);
  }
});
