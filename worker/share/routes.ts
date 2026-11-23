// The CLI share API (Bearer token): GET /v1/account, DELETE /v1/token, POST and GET /v1/shares,
// PATCH and DELETE /v1/shares/<id>. The share page, GET /s/<id>, is in page.ts.

import { bearerAuth, type CliAuth } from '../accounts/device';
import type { AccountEnv } from '../accounts/env';
import { randomId } from '../accounts/crypto';
import { API_HEADERS, siteOrigin } from '../accounts/http';
import {
  deleteShares,
  expiresInSeconds,
  InvalidShareSetting,
  listShares,
  shareJson,
  shareKey,
  shareTitle,
  shareVisibility,
  updateShare,
  type ShareRow,
} from './store';

export const MAX_SHARE_BYTES = 25 * 1024 * 1024;

function reply(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, ...headers } });
}

function fail(status: number, error: string, description: string, headers?: Record<string, string>): Response {
  return reply(status, { ok: false, error, description }, headers);
}

const unauthorized = () => fail(401, 'unauthorized', 'Sign in with the pi CLI again.', { 'WWW-Authenticate': 'Bearer' });
const methodNotAllowed = (allow: string) => fail(405, 'method_not_allowed', `Use ${allow}.`, { Allow: allow });
const invalidRequest = (description: string) => fail(400, 'invalid_request', description);
const noContent = () => {
  const headers = new Headers(API_HEADERS);
  headers.delete('Content-Type');
  return new Response(null, { status: 204, headers });
};

export async function handleShareApi(request: Request, env: AccountEnv): Promise<Response> {
  try {
    return await shareApi(request, env);
  } catch (error) {
    if (error instanceof InvalidShareSetting) return invalidRequest(error.message);
    console.error('share API error', (error as Error)?.stack ?? error);
    return fail(500, 'server_error', 'Something went wrong. Try again.');
  }
}

async function shareApi(request: Request, env: AccountEnv): Promise<Response> {
  const url = new URL(request.url);
  const auth = await bearerAuth(request, env);
  if (!auth) return unauthorized();

  if (url.pathname === '/v1/account') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return reply(200, { ok: true, account: { email: auth.user.email } });
  }
  if (url.pathname === '/v1/token') {
    if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
    await env.DB.prepare('DELETE FROM cli_tokens WHERE id = ?').bind(auth.tokenId).run();
    return noContent();
  }
  if (url.pathname === '/v1/shares') {
    if (request.method === 'GET') return reply(200, { ok: true, shares: await listShares(env, siteOrigin(request), auth.user.id) });
    if (request.method === 'POST') return createShare(request, env, auth, url);
    return methodNotAllowed('GET, POST');
  }
  const id = url.pathname.slice('/v1/shares/'.length);
  if (request.method === 'PATCH') return patchShare(request, env, auth, id);
  if (request.method !== 'DELETE') return methodNotAllowed('DELETE, PATCH');
  if (!(await deleteShares(env, auth.user.id, [id]))) return fail(404, 'not_found', 'No such share.');
  return noContent();
}

/** POST /v1/shares?title=&expires_in=&visibility= with the HTML. Without the last two: no expiry, anyone with the link. */
async function createShare(request: Request, env: AccountEnv, auth: CliAuth, url: URL): Promise<Response> {
  if (!auth.user.email_verified_at) return fail(403, 'email_not_verified', 'Verify your email address at pi-rust.com before you share.');
  const expiresIn = url.searchParams.has('expires_in') ? expiresInSeconds(url.searchParams.get('expires_in'), 'expires_in') : null;
  const visibility = url.searchParams.has('visibility') ? shareVisibility(url.searchParams.get('visibility')) : 'link';
  const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'text/html') return fail(415, 'unsupported_media_type', 'Send the session as text/html; charset=utf-8.');
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_SHARE_BYTES) return fail(413, 'too_large', 'The session is over 25 MiB.');
  const { success } = await env.SHARE_LIMITER.limit({ key: auth.tokenId });
  if (!success) return fail(429, 'rate_limited', 'Too many shares. Try again in a minute.');

  const body = await readLimited(request, MAX_SHARE_BYTES);
  if (!body) return fail(413, 'too_large', 'The session is over 25 MiB.');
  const now = Date.now();
  const row: ShareRow = {
    id: randomId(),
    user_id: auth.user.id,
    title: shareTitle(url.searchParams.get('title')),
    size: body.byteLength,
    created_at: now,
    expires_at: expiresIn === null ? null : now + expiresIn * 1000,
    visibility,
    view_count: 0,
    last_viewed_at: null,
  };
  await env.SHARES.put(shareKey(row.id), body, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  await env.DB.prepare('INSERT INTO shares (id, user_id, title, size, created_at, expires_at, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.user_id, row.title, row.size, row.created_at, row.expires_at, row.visibility)
    .run();
  return reply(201, { ok: true, share: shareJson(siteOrigin(request), row) });
}

/** PATCH /v1/shares/<id> with `{"title"?, "expiresIn"?: seconds | null, "visibility"?}`. */
async function patchShare(request: Request, env: AccountEnv, auth: CliAuth, id: string): Promise<Response> {
  const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return fail(415, 'unsupported_media_type', 'Send JSON.');
  const text = await request.text();
  if (text.length > 64 * 1024) return fail(413, 'too_large', 'Request too large.');
  let body: unknown;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    body = undefined;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalidRequest('The body is not a JSON object.');
  const row = await updateShare(env, auth.user.id, id, body as Record<string, unknown>);
  if (!row) return fail(404, 'not_found', 'No such share.');
  return reply(200, { ok: true, share: shareJson(siteOrigin(request), row) });
}

/** The body, or undefined once it passes `max` bytes (a chunked upload has no Content-Length). */
async function readLimited(request: Request, max: number): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
