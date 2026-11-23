// Local test support, on only with DEV_MAILBOX=1 and a request to localhost (wrangler dev):
//   GET  /__dev/mailbox?to=<email>   the account email the Worker would have sent, newest first
//   POST /__dev/state                moves a row to a state a test cannot wait for (an expired device
//                                    code, share, or email link, an old re-authentication, an unverified
//                                    address, an admin, a bug report without its row)
//   POST /__dev/cleanup              runs the hourly cleanup now, optionally as of {"now": <ms>}
//   GET  /__dev/github/authorize     the fake GitHub's sign-in page, used when no GitHub app is set: a form
//                                    for the GitHub account to sign in as, which posts to
//   GET  /__dev/github/approve       which sends the browser back to the callback with a code
// Everywhere else they answer 404.

import { cleanup, type CleanupEnv } from '../cleanup';
import { base64url, fromBase64url, pkceChallenge } from './crypto';
import { devMailboxOn } from './email';
import type { GitHubClient } from './github';
import { json, type Json } from './http';

interface FakeGitHubAccount {
  id: number;
  login: string;
  email: string;
  verified: boolean;
  /** The PKCE code challenge of the authorization request. */
  challenge: string;
}

const fakeCode = (account: FakeGitHubAccount) => base64url(new TextEncoder().encode(JSON.stringify(account)));

function fakeAccount(code: string): FakeGitHubAccount {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(code))) as FakeGitHubAccount;
  } catch {
    throw new Error('Not a fake GitHub code');
  }
}

/** The fake GitHub: its code and access token are the account chosen on /__dev/github/authorize. */
export function fakeGitHub(origin: string): GitHubClient {
  return {
    authorizeUrl: ({ redirectUri, state, codeChallenge }) =>
      `${origin}/__dev/github/authorize?${new URLSearchParams({ redirect_uri: redirectUri, state, code_challenge: codeChallenge })}`,
    async accessToken(code, codeVerifier) {
      if (fakeAccount(code).challenge !== (await pkceChallenge(codeVerifier))) throw new Error('The PKCE code verifier does not match');
      return code;
    },
    async user(token) {
      const { id, login } = fakeAccount(token);
      return { id, login };
    },
    async verifiedEmail(token) {
      const { email, verified } = fakeAccount(token);
      return verified && email ? email : null;
    },
  };
}

const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function fakeGitHubPage(url: URL): Response {
  const hidden = ['redirect_uri', 'state', 'code_challenge']
    .map((name) => `<input type="hidden" name="${name}" value="${attribute(url.searchParams.get(name) ?? '')}">`)
    .join('');
  const html = `<!doctype html><meta charset="utf-8"><title>Fake GitHub</title>
<h1>Sign in to pi-rust.com with GitHub</h1>
<form action="/__dev/github/approve">${hidden}
<p><label>GitHub user ID <input name="id" inputmode="numeric" required></label></p>
<p><label>Username <input name="login" required></label></p>
<p><label>Primary email <input name="email" type="email"></label></p>
<p><label><input type="checkbox" name="verified" checked> Email verified</label></p>
<p><button>Authorize</button> <button name="cancel" value="1" formnovalidate>Cancel</button></p>
</form>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function fakeGitHubApprove(url: URL): Response {
  const params = url.searchParams;
  const back = new URL(params.get('redirect_uri') ?? '', url.origin);
  if (back.origin !== url.origin || back.pathname !== '/api/account/github/callback') return json(400, { ok: false, error: 'bad_redirect_uri' });
  back.searchParams.set('state', params.get('state') ?? '');
  if (params.has('cancel')) {
    back.searchParams.set('error', 'access_denied');
  } else {
    const account = { id: Number(params.get('id')), login: params.get('login') ?? '', email: params.get('email') ?? '', verified: params.get('verified') === 'on' };
    back.searchParams.set('code', fakeCode({ ...account, challenge: params.get('code_challenge') ?? '' }));
  }
  return new Response(null, { status: 302, headers: { Location: back.toString() } });
}

export async function handleDev(request: Request, env: CleanupEnv): Promise<Response | undefined> {
  if (!devMailboxOn(env, request)) return undefined;
  const url = new URL(request.url);
  if (url.pathname === '/__dev/mailbox' && request.method === 'GET') {
    const to = (url.searchParams.get('to') ?? '').trim().toLowerCase();
    const { results } = await env.DB.prepare(
      'SELECT to_address AS "to", subject, text, html, created_at AS createdAt FROM dev_mailbox WHERE to_address = ? ORDER BY id DESC LIMIT 50',
    )
      .bind(to)
      .all<Json>();
    return json(200, { ok: true, messages: results });
  }
  if (url.pathname === '/__dev/state' && request.method === 'POST') {
    const body = (await request.json()) as { action?: string; email?: string; userCode?: string; id?: string; at?: number };
    const email = (body.email ?? '').toLowerCase();
    const userCode = (body.userCode ?? '').toUpperCase().replace(/-/g, '');
    // An expiry time to set: `at`, or a second ago.
    const at = typeof body.at === 'number' ? body.at : Date.now() - 1000;
    const statements: Record<string, () => Promise<unknown>> = {
      'expire-device-code': () => env.DB.prepare('UPDATE device_codes SET expires_at = ? WHERE user_code = ?').bind(at, userCode).run(),
      'expire-share': () => env.DB.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').bind(at, body.id ?? '').run(),
      'expire-email-tokens': () =>
        env.DB.prepare('UPDATE email_tokens SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').bind(at, email).run(),
      'age-reauth': () =>
        env.DB.prepare('UPDATE sessions SET reauth_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').bind(Date.now() - 11 * 60 * 1000, email).run(),
      unverify: () => env.DB.prepare('UPDATE users SET email_verified_at = NULL WHERE email = ?').bind(email).run(),
      // Production makes the first admin with `wrangler d1 execute`; see docs/admin.md.
      'make-admin': () => env.DB.prepare("UPDATE users SET role = 'admin' WHERE email = ?").bind(email).run(),
      // A report stored in R2 without its D1 row, as when the row failed to write; the cleanup adds it back.
      'unindex-bug-report': () => env.DB.prepare('DELETE FROM bug_reports WHERE id = ?').bind(body.id ?? '').run(),
    };
    const run = statements[body.action ?? ''];
    if (!run) return json(400, { ok: false, error: 'unknown_action' });
    await run();
    return json(200, { ok: true });
  }
  if (url.pathname === '/__dev/github/authorize' && request.method === 'GET') return fakeGitHubPage(url);
  if (url.pathname === '/__dev/github/approve' && request.method === 'GET') return fakeGitHubApprove(url);
  if (url.pathname === '/__dev/cleanup' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { now?: number };
    return json(200, { ok: true, deleted: await cleanup(env, typeof body.now === 'number' ? body.now : undefined) });
  }
  return undefined;
}
