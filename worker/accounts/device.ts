// The RFC 8628 device grant for the pi CLI, its approval API for the /device page, and CLI tokens.

import { requireVerified } from './common';
import { isoTime, userById, type Context, type User } from './context';
import type { AccountEnv } from './env';
import { randomBytes, randomId, randomToken, sha256 } from './crypto';
import { API_HEADERS, HttpError, limitAuth, ok, str, type Json } from './http';
import { requireSession } from './sessions';

export const CLIENT_ID = 'pi-cli';
const SCOPE = 'share';
const DEVICE_CODE_TTL = 900;
const POLL_INTERVAL = 5;
/** A poll up to a second early still counts as on time, for network jitter. */
const POLL_SLACK_MS = 1000;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const CLI_TOKEN_NAME = 'pi CLI';

interface DeviceRow {
  id: string;
  device_code_hash: string;
  user_code: string;
  client_id: string;
  scope: string;
  client_label: string;
  status: 'pending' | 'approved' | 'denied' | 'done';
  user_id: string | null;
  poll_interval: number;
  last_polled_at: number | null;
  created_at: number;
  expires_at: number;
}

function oauthJson(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), { status, headers: API_HEADERS });
}

const oauthError = (error: string, description?: string) => oauthJson(400, description ? { error, error_description: description } : { error });

/** 8 letters from an alphabet without vowels or look-alikes: 20^8, about 2.6 × 10^10 codes. */
function newUserCode(): string {
  let code = '';
  while (code.length < 8) {
    for (const byte of randomBytes(16)) {
      // 240 is the largest multiple of 20 below 256, so every letter is equally likely.
      if (byte < 240 && code.length < 8) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    }
  }
  return code;
}

/** "bcdf-ghjk", "BCDFGHJK", and "bcdf ghjk" are the same code. Returns undefined for anything else. */
export function normalizeUserCode(input: string): string | undefined {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return code.length === 8 && [...code].every((char) => USER_CODE_ALPHABET.includes(char)) ? code : undefined;
}

export const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** "pi 0.12.26 on Linux" from the pi-rust User-Agent, else "pi CLI". */
function clientLabel(userAgent: string | null): string {
  const match = /^pi\/(\S{1,40}) \(([a-z0-9_]{1,16});/.exec(userAgent ?? '');
  if (!match) return CLI_TOKEN_NAME;
  const platforms: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows', windows: 'Windows', freebsd: 'FreeBSD' };
  return `pi ${match[1]} on ${platforms[match[2]] ?? match[2]}`;
}

async function readForm(request: Request): Promise<URLSearchParams | undefined> {
  const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return undefined;
  const text = await request.text();
  return text.length > 4096 ? undefined : new URLSearchParams(text);
}

/** POST /oauth/device_authorization */
export async function deviceAuthorization(c: Context): Promise<Response> {
  if (c.request.method !== 'POST') return new Response(null, { status: 405, headers: { ...API_HEADERS, Allow: 'POST' } });
  try {
    await limitAuth(c.env.AUTH_LIMITER, c.request, 'device');
  } catch {
    return oauthJson(429, { error: 'rate_limited', error_description: 'Too many requests. Wait a minute and try again.' });
  }
  const form = await readForm(c.request);
  if (!form) return oauthError('invalid_request', 'Send application/x-www-form-urlencoded.');
  if (form.get('client_id') !== CLIENT_ID) return oauthError('invalid_client');
  const scope = form.get('scope') ?? SCOPE;
  if (scope !== SCOPE) return oauthError('invalid_scope');
  const deviceCode = randomToken();
  const now = Date.now();
  await c.env.DB.prepare('DELETE FROM device_codes WHERE expires_at < ?').bind(now - 24 * 60 * 60 * 1000).run();
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = newUserCode();
    try {
      await c.env.DB.prepare(
        'INSERT INTO device_codes (id, device_code_hash, user_code, client_id, scope, client_label, poll_interval, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(randomId(), await sha256(deviceCode), userCode, CLIENT_ID, scope, clientLabel(c.request.headers.get('User-Agent')), POLL_INTERVAL, now, now + DEVICE_CODE_TTL * 1000)
        .run();
    } catch {
      continue; // The user code is taken; draw another.
    }
    const shown = formatUserCode(userCode);
    return oauthJson(200, {
      device_code: deviceCode,
      user_code: shown,
      verification_uri: `${c.origin}/device`,
      verification_uri_complete: `${c.origin}/device?user_code=${shown}`,
      expires_in: DEVICE_CODE_TTL,
      interval: POLL_INTERVAL,
    });
  }
  throw new Error('could not allocate a user code');
}

/** Creates a CLI token for a user. Only its hash is stored; the token is returned once. */
async function issueCliToken(env: AccountEnv, userId: string): Promise<string> {
  const token = `pirs_${randomToken()}`;
  await env.DB.prepare('INSERT INTO cli_tokens (id, user_id, token_hash, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(randomId(), userId, await sha256(token), CLI_TOKEN_NAME, Date.now())
    .run();
  return token;
}

/** POST /oauth/token with the device code grant. */
export async function deviceToken(c: Context): Promise<Response> {
  if (c.request.method !== 'POST') return new Response(null, { status: 405, headers: { ...API_HEADERS, Allow: 'POST' } });
  const form = await readForm(c.request);
  if (!form) return oauthError('invalid_request', 'Send application/x-www-form-urlencoded.');
  if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code') return oauthError('unsupported_grant_type');
  if (form.get('client_id') !== CLIENT_ID) return oauthError('invalid_client');
  const deviceCode = form.get('device_code') ?? '';
  if (!deviceCode || deviceCode.length > 100) return oauthError('invalid_grant');
  const row = await c.env.DB.prepare('SELECT * FROM device_codes WHERE device_code_hash = ?').bind(await sha256(deviceCode)).first<DeviceRow>();
  if (!row || row.client_id !== CLIENT_ID || row.status === 'done') return oauthError('invalid_grant');
  const now = Date.now();
  if (row.expires_at < now) return oauthError('expired_token');

  if (row.status === 'pending') {
    const early = row.last_polled_at !== null && now - row.last_polled_at < row.poll_interval * 1000 - POLL_SLACK_MS;
    // RFC 8628 3.5: after slow_down, the client waits 5 seconds longer for this and every later poll.
    await c.env.DB.prepare('UPDATE device_codes SET last_polled_at = ?, poll_interval = ? WHERE id = ?')
      .bind(now, early ? row.poll_interval + 5 : row.poll_interval, row.id)
      .run();
    return oauthError(early ? 'slow_down' : 'authorization_pending');
  }
  if (row.status === 'denied') {
    await c.env.DB.prepare("UPDATE device_codes SET status = 'done' WHERE id = ?").bind(row.id).run();
    return oauthError('access_denied');
  }
  // Approved: the first poll to mark the code done gets the token.
  const claimed = await c.env.DB.prepare("UPDATE device_codes SET status = 'done', last_polled_at = ? WHERE id = ? AND status = 'approved'").bind(now, row.id).run();
  if (claimed.meta.changes !== 1 || !row.user_id) return oauthError('invalid_grant');
  const user = await userById(c, row.user_id);
  if (!user) return oauthError('access_denied');
  const token = await issueCliToken(c.env, user.id);
  return oauthJson(200, { access_token: token, token_type: 'Bearer', scope: row.scope, account: { email: user.email } });
}

async function pendingRequest(c: Context, input: string): Promise<DeviceRow> {
  const code = normalizeUserCode(input);
  const missing = new HttpError(404, 'not_found', 'That code is not valid. Check the code in your terminal.', { field: 'user_code' });
  if (!code) throw missing;
  const row = await c.env.DB.prepare('SELECT * FROM device_codes WHERE user_code = ?').bind(code).first<DeviceRow>();
  if (!row || row.status !== 'pending') throw missing;
  if (row.expires_at < Date.now()) throw new HttpError(410, 'expired', 'That code expired. Start the sign-in again in your terminal.', { field: 'user_code' });
  return row;
}

async function deviceUser(c: Context): Promise<User> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'device');
  const { user } = await requireSession(c);
  requireVerified(user);
  return user;
}

/** GET /api/account/device?user_code=XXXX-XXXX: the request the code belongs to. */
export async function deviceLookup(c: Context): Promise<Response> {
  await deviceUser(c);
  const row = await pendingRequest(c, c.url.searchParams.get('user_code') ?? '');
  return ok({
    request: { userCode: formatUserCode(row.user_code), client: row.client_label, createdAt: isoTime(row.created_at), expiresAt: isoTime(row.expires_at) },
  });
}

async function decide(c: Context, body: Json, status: 'approved' | 'denied'): Promise<Response> {
  const user = await deviceUser(c);
  const row = await pendingRequest(c, str(body, 'user_code', 40));
  const result = await c.env.DB.prepare("UPDATE device_codes SET status = ?, user_id = ? WHERE id = ? AND status = 'pending'").bind(status, user.id, row.id).run();
  if (result.meta.changes !== 1) throw new HttpError(409, 'not_pending', 'This request was already answered.');
  return ok({ status });
}

/** POST /api/account/device/approve */
export const approveDevice = (c: Context, body: Json) => decide(c, body, 'approved');
/** POST /api/account/device/deny */
export const denyDevice = (c: Context, body: Json) => decide(c, body, 'denied');

export interface CliAuth {
  tokenId: string;
  user: User;
}

/** The user behind a `Authorization: Bearer pirs_...` header, or undefined. Records when the token was last used. */
export async function bearerAuth(request: Request, env: AccountEnv): Promise<CliAuth | undefined> {
  const match = /^Bearer\s+(pirs_[A-Za-z0-9_-]{20,100})\s*$/.exec(request.headers.get('Authorization') ?? '');
  if (!match) return undefined;
  const row = await env.DB.prepare('SELECT id, user_id, last_used_at FROM cli_tokens WHERE token_hash = ?')
    .bind(await sha256(match[1]))
    .first<{ id: string; user_id: string; last_used_at: number | null }>();
  if (!row) return undefined;
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first<User>();
  if (!user || user.suspended_at) return undefined;
  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    await env.DB.prepare('UPDATE cli_tokens SET last_used_at = ? WHERE id = ?').bind(now, row.id).run();
  }
  return { tokenId: row.id, user };
}
