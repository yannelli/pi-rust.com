// Helpers for the account and sharing tests: API clients with their own cookie jar and client IP,
// the dev mailbox, TOTP codes, and direct writes to the local D1 database.

import { expect, type APIRequestContext, type BrowserContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { TERMS_VERSION } from '../../src/lib/legal';

type Playwright = PlaywrightWorkerArgs['playwright'];
import { createHmac, randomBytes } from 'node:crypto';

export const PASSWORD = 'correct horse battery staple';
/** What the sign-up page sends when the Terms box is checked. */
export const TERMS = { acceptTerms: true, termsVersion: TERMS_VERSION } as const;

export function uniqueEmail(tag: string): string {
  return `${tag}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}@example.com`;
}

/** A client IP of its own for each client, so the rate limits of one test never reach another. */
export function testIp(): string {
  const bytes = randomBytes(3);
  return `10.${bytes[0]}.${bytes[1]}.${bytes[2]}`;
}

/** A browser-like API client: the site Origin on every request and its own cookie jar. */
export async function accountClient(playwright: Playwright, baseURL: string, ip = testIp()): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL, 'CF-Connecting-IP': ip } });
}

/** A pi CLI-like client: no Origin, no cookies. */
export async function cliClient(playwright: Playwright, baseURL: string, token?: string): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { 'CF-Connecting-IP': testIp(), 'User-Agent': 'pi/0.12.26 (linux; rust; x64)', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

/** Sends the CF-Connecting-IP header with the page's account API calls only (other hosts would reject it in CORS). */
export async function pageIp(context: BrowserContext, ip = testIp()): Promise<void> {
  await context.route(/\/(api\/account|oauth)\//, (route) => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }));
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function mailbox(request: APIRequestContext, to: string): Promise<Mail[]> {
  const response = await request.get(`/__dev/mailbox?to=${encodeURIComponent(to)}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).messages;
}

/** Waits for a message whose subject matches, and returns it. Email is sent after the response. */
export async function waitForMail(request: APIRequestContext, to: string, subject: RegExp): Promise<Mail> {
  let found: Mail | undefined;
  await expect
    .poll(async () => {
      found = (await mailbox(request, to)).find((mail) => subject.test(mail.subject));
      return Boolean(found);
    }, { message: `email "${subject}" to ${to}` })
    .toBe(true);
  return found!;
}

export function linkIn(mail: Mail, path: RegExp): string {
  const match = mail.text.match(new RegExp(`https?://\\S+${path.source}\\S*`));
  if (!match) throw new Error(`No ${path} link in: ${mail.text}`);
  return match[0];
}

export const tokenOf = (link: string) => new URL(link).hash.replace(/^#token=/, '');

/** Signs up, verifies, and signs in. Returns the signed-in client. */
export async function verifiedAccount(playwright: Playwright, baseURL: string, email = uniqueEmail('user')): Promise<{ client: APIRequestContext; email: string }> {
  const client = await accountClient(playwright, baseURL);
  expect((await client.post('/api/account/sign-up', { data: { email, password: PASSWORD, ...TERMS } })).status()).toBe(200);
  const mail = await waitForMail(client, email, /Verify your email/);
  expect((await client.post('/api/account/verify', { data: { token: tokenOf(linkIn(mail, /\/account\/verify\//)) } })).status()).toBe(200);
  expect((await client.post('/api/account/sign-in', { data: { email, password: PASSWORD } })).status()).toBe(200);
  return { client, email };
}

/** Runs the device grant for a signed-in, verified client and returns the CLI token. */
export async function cliToken(playwright: Playwright, baseURL: string, client: APIRequestContext): Promise<string> {
  const cli = await cliClient(playwright, baseURL);
  const grant = await (await cli.post('/oauth/device_authorization', { form: { client_id: 'pi-cli', scope: 'share' } })).json();
  expect((await client.post('/api/account/device/approve', { data: { user_code: grant.user_code } })).status()).toBe(200);
  const token = await cli.post('/oauth/token', {
    form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: grant.device_code, client_id: 'pi-cli' },
  });
  expect(token.status()).toBe(200);
  return (await token.json()).access_token;
}

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/[\s=]/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The RFC 6238 code for a base32 secret, `offset` 30-second steps from now. */
export function totp(secret: string, offset = 0): string {
  const counter = Math.floor(Date.now() / 1000 / 30) + offset;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const start = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(start) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Moves a row to a state a test cannot wait for, through the Worker's dev-only /__dev/state. `at` sets the expiry time. */
export async function devState(
  request: APIRequestContext,
  state:
    | { action: 'expire-device-code'; userCode: string; at?: number }
    | { action: 'expire-share'; id: string; at?: number }
    | { action: 'expire-email-tokens'; email: string; at?: number }
    | { action: 'age-reauth' | 'unverify' | 'make-admin'; email: string }
    | { action: 'unindex-bug-report'; id: string },
): Promise<void> {
  const response = await request.post('/__dev/state', { data: state });
  expect(response.status()).toBe(200);
}

/**
 * A verified, signed-in admin with two-step verification on, as the admin area needs. Returns the client, the
 * address, and the TOTP secret.
 */
export async function adminAccount(playwright: Playwright, baseURL: string): Promise<{ client: APIRequestContext; email: string; secret: string }> {
  const { client, email } = await verifiedAccount(playwright, baseURL, uniqueEmail('admin'));
  const { secret } = await (await client.post('/api/account/totp/setup', { data: {} })).json();
  expect((await client.post('/api/account/totp/enable', { data: { code: totp(secret) } })).status()).toBe(200);
  await devState(client, { action: 'make-admin', email });
  return { client, email, secret };
}

/** Signs up and verifies an address through the API, without signing in. */
export async function createVerified(request: APIRequestContext, email: string): Promise<void> {
  expect((await request.post('/api/account/sign-up', { data: { email, password: PASSWORD, ...TERMS } })).status()).toBe(200);
  const mail = await waitForMail(request, email, /Verify your email/);
  expect((await request.post('/api/account/verify', { data: { token: tokenOf(linkIn(mail, /\/account\/verify\//)) } })).status()).toBe(200);
}
