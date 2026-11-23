// Routes for /api/account/*, /oauth/*, and the account pages. Every state-changing account API request
// must be JSON from the site origin (see checkSameOrigin).

import * as auth from './auth';
import { context, withCookies, type Context } from './context';
import { approveDevice, denyDevice, deviceAuthorization, deviceLookup, deviceToken } from './device';
import * as emailChange from './email-change';
import type { AccountEnv, ExecutionContext } from './env';
import { checkSameOrigin, fail, HttpError, PAGE_HEADERS, readJson, type Json } from './http';
import * as security from './security';
import { loadSession } from './sessions';
import { deleteAllSharesOfAccount, deleteExpiredSharesOfAccount, updateShareOfAccount } from '../share/account';
import { NO_INDEX } from '../share/page';

type Handler = (c: Context, body: Json, id: string) => Promise<Response>;

const ID = '([A-Za-z0-9_-]{1,64})';

const ROUTES: [method: string, path: RegExp, handler: Handler][] = [
  ['GET', /^me$/, (c) => security.me(c)],
  ['POST', /^sign-up$/, (c, body) => auth.signUp(c, body)],
  ['POST', /^sign-in$/, (c, body) => auth.signIn(c, body)],
  ['POST', /^sign-in\/totp$/, (c, body) => auth.signInTotp(c, body)],
  ['POST', /^sign-in\/recovery$/, (c, body) => auth.signInRecovery(c, body)],
  ['POST', /^sign-in\/passkey\/options$/, (c, body) => auth.signInPasskeyOptions(c, body)],
  ['POST', /^sign-in\/passkey$/, (c, body) => auth.signInPasskey(c, body)],
  ['POST', /^sign-out$/, (c) => auth.signOut(c)],
  ['POST', /^verify$/, (c, body) => auth.verifyEmail(c, body)],
  ['POST', /^verify\/resend$/, (c) => auth.resendVerification(c)],
  ['POST', /^reset\/request$/, (c, body) => auth.requestReset(c, body)],
  ['POST', /^reset$/, (c, body) => auth.resetPassword(c, body)],
  ['POST', /^email\/change$/, (c, body) => emailChange.requestChange(c, body)],
  ['POST', /^email\/change\/cancel$/, (c) => emailChange.cancelChange(c)],
  ['POST', /^email\/confirm$/, (c, body) => emailChange.confirmChange(c, body)],
  ['POST', /^email\/undo$/, (c, body) => emailChange.undoChange(c, body)],
  ['POST', /^reauth$/, (c, body) => auth.reauthPassword(c, body)],
  ['POST', /^reauth\/passkey\/options$/, (c) => auth.reauthPasskeyOptions(c)],
  ['POST', /^reauth\/passkey$/, (c, body) => auth.reauthPasskey(c, body)],
  ['POST', /^password$/, (c, body) => security.changePassword(c, body)],
  ['POST', /^totp\/setup$/, (c) => security.totpSetup(c)],
  ['POST', /^totp\/enable$/, (c, body) => security.totpEnable(c, body)],
  ['POST', /^totp\/disable$/, (c) => security.totpDisable(c)],
  ['POST', /^recovery-codes$/, (c) => security.regenerateRecoveryCodes(c)],
  ['GET', /^passkeys$/, (c) => security.listPasskeys(c)],
  ['POST', /^passkeys\/options$/, (c) => security.passkeyRegistrationOptions(c)],
  ['POST', /^passkeys$/, (c, body) => security.addPasskey(c, body)],
  ['PATCH', new RegExp(`^passkeys/${ID}$`), (c, body, id) => security.renamePasskey(c, id, body)],
  ['DELETE', new RegExp(`^passkeys/${ID}$`), (c, _body, id) => security.removePasskey(c, id)],
  ['GET', /^sessions$/, (c) => security.listSessions(c)],
  ['POST', /^sessions\/revoke-others$/, (c) => security.revokeOtherSessions(c)],
  ['DELETE', new RegExp(`^sessions/${ID}$`), (c, _body, id) => security.revokeSession(c, id)],
  ['GET', /^tokens$/, (c) => security.listTokens(c)],
  ['DELETE', new RegExp(`^tokens/${ID}$`), (c, _body, id) => security.revokeToken(c, id)],
  ['GET', /^shares$/, (c) => security.sharesOfAccount(c)],
  ['POST', /^shares\/delete-expired$/, (c) => deleteExpiredSharesOfAccount(c)],
  ['POST', /^shares\/delete-all$/, (c) => deleteAllSharesOfAccount(c)],
  ['PATCH', new RegExp(`^shares/${ID}$`), (c, body, id) => updateShareOfAccount(c, id, body)],
  ['DELETE', new RegExp(`^shares/${ID}$`), (c, _body, id) => security.deleteShareOfAccount(c, id)],
  ['GET', /^device$/, (c) => deviceLookup(c)],
  ['POST', /^device\/approve$/, (c, body) => approveDevice(c, body)],
  ['POST', /^device\/deny$/, (c, body) => denyDevice(c, body)],
  ['POST', /^delete$/, (c) => security.deleteAccount(c)],
];

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return fail(error.status, error.code, error.description, error.extra);
  console.error('account API error', (error as Error)?.stack ?? error);
  return fail(500, 'server_error', 'Something went wrong. Try again.');
}

/** /api/account/* */
export async function handleAccountApi(request: Request, env: AccountEnv, ctx: ExecutionContext): Promise<Response> {
  const c = context(request, env, ctx);
  const path = c.url.pathname.slice('/api/account/'.length);
  const matches = ROUTES.filter(([, pattern]) => pattern.test(path));
  if (!matches.length) return fail(404, 'not_found', 'No such endpoint.');
  const route = matches.find(([method]) => method === request.method);
  if (!route) return fail(405, 'method_not_allowed', 'Method not allowed.', {}, { Allow: matches.map(([method]) => method).join(', ') });
  const [method, pattern, handler] = route;
  try {
    let body: Json = {};
    if (method !== 'GET') {
      checkSameOrigin(request);
      body = await readJson(request);
    }
    const id = pattern.exec(path)?.[1] ?? '';
    return withCookies(c, await handler(c, body, id));
  } catch (error) {
    return withCookies(c, errorResponse(error));
  }
}

/** /oauth/device_authorization and /oauth/token. */
export async function handleOAuth(request: Request, env: AccountEnv, ctx: ExecutionContext): Promise<Response> {
  const c = context(request, env, ctx);
  try {
    const path = c.url.pathname;
    if (path === '/oauth/device_authorization') return await deviceAuthorization(c);
    if (path === '/oauth/token') return await deviceToken(c);
    return fail(404, 'not_found', 'No such endpoint.');
  } catch (error) {
    console.error('oauth error', (error as Error)?.stack ?? error);
    return fail(500, 'server_error', 'Something went wrong. Try again.');
  }
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/** Pages that need a signed-in user. The rest of /account/ (sign-in, sign-up, verify, reset) is public. */
const SIGNED_IN_PAGES = new Set(['/account/', '/account/security/', '/account/settings/', '/device/']);
/** Pages a signed-in user skips. */
const SIGNED_OUT_PAGES = new Set(['/account/sign-in/', '/account/sign-up/']);

/** Where to go after sign-in: an account, admin, or device page or a share (/s/<id>) on this site, else the account home. */
export function safeNext(value: string | null): string {
  if (!value || value.startsWith('//') || /[\\\s]/.test(value)) return '/account/';
  if (/^\/(account|admin|device)(\/|\?|$)/.test(value) || /^\/s\/[A-Za-z0-9_-]{22}$/.test(value)) return value;
  return '/account/';
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

/**
 * The site's 404 page, for an admin page asked for by anyone but an admin. A path with no asset gets it
 * (not_found_handling in wrangler.jsonc); /404.html itself redirects.
 */
async function notFoundPage(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
  const page = await env.ASSETS.fetch(new Request(new URL('/__not-found__/', request.url)));
  return new Response(page.body, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/**
 * /account/*, /admin/*, /device/, and /session/: the static pages with security headers. Signed-in pages
 * redirect to sign-in first, and sign-in redirects a signed-in user on. Admin pages are a 404 to anyone
 * signed in who is not an admin.
 */
export async function servePage(request: Request, env: AccountEnv & { ASSETS: Fetcher }, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const viewer = url.pathname === '/session' || url.pathname.startsWith('/session/');
  const admin = url.pathname.startsWith('/admin/');
  // The bare paths keep their query (?user_code=) on the way to the page.
  if (url.pathname === '/device' || url.pathname === '/session' || url.pathname === '/account' || url.pathname === '/admin') {
    const response = redirect(`${url.pathname}/${url.search}`);
    if (viewer) response.headers.set('X-Robots-Tag', NO_INDEX);
    return response;
  }
  const c = context(request, env, ctx);
  if (admin || (request.method === 'GET' && (SIGNED_IN_PAGES.has(url.pathname) || SIGNED_OUT_PAGES.has(url.pathname)))) {
    let auth: Awaited<ReturnType<typeof loadSession>> = null;
    try {
      auth = await loadSession(c);
    } catch (error) {
      console.error('session lookup failed', (error as Error)?.message);
    }
    if (!auth && (admin || SIGNED_IN_PAGES.has(url.pathname))) {
      return redirect(`/account/sign-in/?next=${encodeURIComponent(url.pathname + url.search)}`);
    }
    if (admin && auth?.user.role !== 'admin') return withCookies(c, withHeaders(await notFoundPage(request, env), PAGE_HEADERS));
    if (auth && SIGNED_OUT_PAGES.has(url.pathname)) return withCookies(c, redirect(safeNext(url.searchParams.get('next'))));
  }
  const asset = await env.ASSETS.fetch(request);
  const headers = viewer
    ? // The viewer shows a session in a srcdoc frame, which inherits this page's CSP; the frame's sandbox
      // (no allow-same-origin) is what isolates it, so the CSP only stops framing. Shared sessions are never indexed.
      { ...PAGE_HEADERS, 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Robots-Tag': NO_INDEX }
    : admin
      ? { ...PAGE_HEADERS, 'X-Robots-Tag': 'noindex, nofollow' }
      : PAGE_HEADERS;
  return withCookies(c, withHeaders(asset, headers));
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}
