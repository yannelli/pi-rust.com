// Sign in with GitHub: the OAuth web flow with PKCE, for three purposes.
//
// - sign-in: a connected GitHub account signs in to its pi-rust account, with the second step when the
//   account has one. A GitHub account that is not connected goes to /account/sign-up/?github=1, which
//   creates an account with GitHub's verified primary email once the Terms are accepted. When that email
//   already has an account, it goes to /account/sign-in/?github=link instead: GitHub never joins an account
//   by its email alone, so the owner signs in, and then POST /api/account/github/link connects GitHub.
// - connect: a signed-in user, after a recent confirmation, connects a GitHub account.
// - reauth: a signed-in user with GitHub connected confirms it's them.
//
// See docs/accounts.md.

import { hasSecondStep, startSecondStep } from './auth';
import { passkeyCount, requireTerms, resetLink } from './common';
import { isoTime, userByEmail, userById, type Context, type SessionRow, type User } from './context';
import { pkceChallenge, randomId, randomToken, sha256, timingSafeEqualText } from './crypto';
import { fakeGitHub } from './dev';
import { devMailboxOn, sendEmail } from './email';
import { clearCookie, HttpError, isEmail, limitAuth, normalizeEmail, ok, readCookie, redirect, safeNext, setCookie, str, type Json } from './http';
import { loadSession, refuseSuspended, requireRecentAuth, requireSession, rotateSession, startSession } from './sessions';
import { TERMS_VERSION } from '../../src/lib/legal';

export const GITHUB_COOKIE = '__Host-pirs_github';
const TRIP_TTL = 10 * 60 * 1000;
const CALLBACK_PATH = '/api/account/github/callback';

export interface GitHubUser {
  id: number;
  login: string;
}

/** GitHub's OAuth and REST endpoints, or the fake GitHub of local tests (dev.ts). */
export interface GitHubClient {
  authorizeUrl(params: { redirectUri: string; state: string; codeChallenge: string }): string;
  accessToken(code: string, codeVerifier: string, redirectUri: string): Promise<string>;
  user(token: string): Promise<GitHubUser>;
  /** The account's primary email when GitHub verified it, else null. */
  verifiedEmail(token: string): Promise<string | null>;
}

const USER_AGENT = 'pi-rust.com';

function githubApi(clientId: string, clientSecret: string): GitHubClient {
  async function rest<T>(token: string, path: string): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': '2026-03-10' },
    });
    if (!response.ok) throw new Error(`GitHub ${path} answered ${response.status}`);
    return (await response.json()) as T;
  }
  return {
    authorizeUrl({ redirectUri, state, codeChallenge }) {
      const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: 'user:email', state, code_challenge: codeChallenge, code_challenge_method: 'S256' });
      return `https://github.com/login/oauth/authorize?${query}`;
    },
    async accessToken(code, codeVerifier, redirectUri) {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, code_verifier: codeVerifier }),
      });
      // GitHub answers an error with status 200 and an `error` field.
      const data = (await response.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
      if (typeof data.access_token !== 'string') throw new Error(`GitHub token exchange failed: ${response.status} ${String(data.error ?? '')}`);
      return data.access_token;
    },
    async user(token) {
      const data = await rest<{ id?: unknown; login?: unknown }>(token, '/user');
      if (typeof data.id !== 'number' || typeof data.login !== 'string') throw new Error('GitHub /user has no id or login');
      return { id: data.id, login: data.login };
    },
    async verifiedEmail(token) {
      const emails = await rest<{ email?: unknown; primary?: unknown; verified?: unknown }[]>(token, '/user/emails');
      const primary = Array.isArray(emails) ? emails.find((entry) => entry.primary === true && entry.verified === true) : undefined;
      return typeof primary?.email === 'string' ? primary.email : null;
    },
  };
}

/** The GitHub app in GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET; without them, the fake GitHub in local tests. */
function client(c: Context): GitHubClient {
  const { GITHUB_CLIENT_ID: id, GITHUB_CLIENT_SECRET: secret } = c.env;
  if (id && secret) return githubApi(id, secret);
  if (devMailboxOn(c.env, c.request)) return fakeGitHub(c.origin);
  console.error('GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is not set');
  throw new HttpError(503, 'not_configured', 'Sign-in with GitHub is not available right now.');
}

type Purpose = 'sign-in' | 'connect' | 'reauth';

interface TripRow {
  token_hash: string;
  purpose: Purpose | 'sign-up' | 'link';
  user_id: string | null;
  code_verifier: string | null;
  next: string;
  github_id: number | null;
  login: string | null;
  email: string | null;
  expires_at: number;
}

export interface ConnectedGitHub {
  github_id: number;
  login: string;
  created_at: number;
  last_used_at: number | null;
}

export async function connectedGitHub(c: Context, userId: string): Promise<ConnectedGitHub | null> {
  return c.env.DB.prepare('SELECT github_id, login, created_at, last_used_at FROM github_accounts WHERE user_id = ?').bind(userId).first<ConnectedGitHub>();
}

/** The GitHub account for GET /api/account/me. */
export async function githubSummary(c: Context, userId: string) {
  const row = await connectedGitHub(c, userId);
  return row ? { login: row.login, connectedAt: isoTime(row.created_at), lastUsedAt: isoTime(row.last_used_at) } : null;
}

/** POST /api/account/github/start with `{"intent", "next"}`: the GitHub address the page sends the browser to. */
export async function start(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'github');
  const purpose = body.intent;
  if (purpose !== 'sign-in' && purpose !== 'connect' && purpose !== 'reauth') throw new HttpError(400, 'invalid_intent', 'Unknown intent.');
  const github = client(c);
  let next = safeNext(str(body, 'next', 2048) || null);
  let userId: string | null = null;
  if (purpose !== 'sign-in') {
    const { session, user } = await requireSession(c);
    const connected = await connectedGitHub(c, user.id);
    if (purpose === 'connect') {
      requireRecentAuth(session);
      if (connected) throw new HttpError(409, 'github_connected', 'GitHub is already connected. Disconnect it first.');
      next = '/account/security/';
    } else if (!connected) {
      throw new HttpError(400, 'github_not_connected', 'GitHub is not connected to your account.');
    }
    userId = user.id;
  }
  const token = randomToken();
  const verifier = randomToken();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM github_states WHERE expires_at < ?').bind(now),
    c.env.DB.prepare('INSERT INTO github_states (token_hash, purpose, user_id, code_verifier, next, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      await sha256(token),
      purpose,
      userId,
      verifier,
      next,
      now,
      now + TRIP_TTL,
    ),
  ]);
  c.cookies.push(setCookie(GITHUB_COOKIE, token, TRIP_TTL / 1000));
  return ok({ url: github.authorizeUrl({ redirectUri: c.origin + CALLBACK_PATH, state: token, codeChallenge: await pkceChallenge(verifier) }) });
}

/** A failed trip; the code goes to the page as ?github_error=, which shows its message. */
type TripErrorCode = 'expired' | 'failed' | 'rate_limited' | 'suspended' | 'no_email' | 'email_taken' | 'taken' | 'mismatch';

class TripError extends Error {
  constructor(readonly code: TripErrorCode) {
    super(code);
  }
}

/** A site path with query parameters added. `next` is left out when it is the default, the account home. */
function withParams(path: string, params: Record<string, string>): string {
  const url = new URL(path, 'https://pi-rust.com');
  for (const [name, value] of Object.entries(params)) {
    if (!(name === 'next' && value === '/account/')) url.searchParams.set(name, value);
  }
  return url.pathname + url.search;
}

/** Where a trip goes back to when it does not finish. */
function startedFrom(row: TripRow): string {
  if (row.purpose === 'connect') return '/account/security/';
  if (row.purpose === 'reauth') return row.next;
  return withParams('/account/sign-in/', { next: row.next });
}

function tripErrorCode(error: unknown): TripErrorCode {
  if (error instanceof TripError) return error.code;
  if (error instanceof HttpError && error.code === 'rate_limited') return 'rate_limited';
  if (error instanceof HttpError && error.code === 'github_taken') return 'taken';
  if (error instanceof HttpError && error.code === 'account_suspended') return 'suspended';
  console.error('GitHub sign-in failed', (error as Error)?.stack ?? error);
  return 'failed';
}

/** GET /api/account/github/callback?code=&state=: GitHub sends the browser back here. The answer is always a redirect. */
export async function callback(c: Context): Promise<Response> {
  const params = c.url.searchParams;
  const cookie = readCookie(c.request, GITHUB_COOKIE);
  let row: TripRow | null = null;
  let location: string;
  try {
    if (!cookie || cookie.length > 100 || !timingSafeEqualText(params.get('state') ?? '', cookie)) throw new TripError('expired');
    // Deleted as it is read, so each trip works once.
    row = await c.env.DB.prepare("DELETE FROM github_states WHERE token_hash = ? AND purpose IN ('sign-in', 'connect', 'reauth') RETURNING *")
      .bind(await sha256(cookie))
      .first<TripRow>();
    if (!row || row.expires_at < Date.now()) {
      row = null;
      throw new TripError('expired');
    }
    await limitAuth(c.env.AUTH_LIMITER, c.request, 'github');
    const code = params.get('code');
    const error = params.get('error');
    if (error === 'access_denied') {
      // The user cancelled on GitHub.
      location = startedFrom(row);
    } else {
      if (error || !code) throw new Error(`GitHub answered ${error ?? 'without a code'}`);
      const github = client(c);
      const token = await github.accessToken(code, row.code_verifier ?? '', c.origin + CALLBACK_PATH);
      const account = await github.user(token);
      if (row.purpose === 'connect') location = await connect(c, row, account);
      else if (row.purpose === 'reauth') location = await reauth(c, row, account);
      else location = await signIn(c, row, account, () => github.verifiedEmail(token));
    }
  } catch (error) {
    location = withParams(row ? startedFrom(row) : '/account/sign-in/', { github_error: tripErrorCode(error) });
  }
  // The trip is over, unless a sign-up step set a cookie of its own.
  if (!c.cookies.some((value) => value.startsWith(`${GITHUB_COOKIE}=`))) c.cookies.push(clearCookie(GITHUB_COOKIE));
  return redirect(location);
}

async function touch(c: Context, account: GitHubUser): Promise<void> {
  await c.env.DB.prepare('UPDATE github_accounts SET login = ?, last_used_at = ? WHERE github_id = ?').bind(account.login, Date.now(), account.id).run();
}

async function signIn(c: Context, row: TripRow, account: GitHubUser, verifiedEmail: () => Promise<string | null>): Promise<string> {
  const user = await c.env.DB.prepare('SELECT users.* FROM github_accounts JOIN users ON users.id = github_accounts.user_id WHERE github_accounts.github_id = ?')
    .bind(account.id)
    .first<User>();
  if (user) {
    refuseSuspended(user);
    await touch(c, account);
    const methods = await hasSecondStep(c, user);
    if (methods) {
      await startSecondStep(c, user);
      const available = Object.entries(methods).flatMap(([method, on]) => (on ? [method] : []));
      return withParams('/account/sign-in/', { next: row.next, two_step: available.join(',') });
    }
    await startSession(c, user, { reauth: true });
    return row.next;
  }
  const email = normalizeEmail((await verifiedEmail()) ?? '');
  if (!isEmail(email)) throw new TripError('no_email');
  const owner = await userByEmail(c, email);
  if (owner && (await connectedGitHub(c, owner.id))) throw new TripError('email_taken');
  // A new token for the next step: the old one was in the addresses the browser visited.
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare('INSERT INTO github_states (token_hash, purpose, user_id, next, github_id, login, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(await sha256(token), owner ? 'link' : 'sign-up', owner?.id ?? null, row.next, account.id, account.login, email, now, now + TRIP_TTL)
    .run();
  c.cookies.push(setCookie(GITHUB_COOKIE, token, TRIP_TTL / 1000));
  return owner ? withParams('/account/sign-in/', { github: 'link', next: row.next }) : withParams('/account/sign-up/', { github: '1', next: row.next });
}

/** The signed-in session that started a connect or reauth trip. */
async function tripSession(c: Context, row: TripRow) {
  const auth = await loadSession(c);
  if (!auth || auth.user.id !== row.user_id) throw new TripError('expired');
  return auth;
}

/** Connects a GitHub account to the signed-in user, whose session gets a new token, and emails them. */
async function connectGitHub(c: Context, session: SessionRow, user: User, account: GitHubUser): Promise<void> {
  const now = Date.now();
  try {
    await c.env.DB.prepare('INSERT INTO github_accounts (user_id, github_id, login, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)')
      .bind(user.id, account.id, account.login, now, now)
      .run();
  } catch (error) {
    const message = (error as Error)?.message ?? '';
    if (/UNIQUE.*github_id/i.test(message)) throw new HttpError(409, 'github_taken', 'That GitHub account is connected to another pi-rust account.');
    if (/UNIQUE/i.test(message)) throw new HttpError(409, 'github_connected', 'GitHub is already connected. Disconnect it first.');
    throw error;
  }
  await rotateSession(c, session);
  sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'github-connected', login: account.login, resetLink: resetLink(c) });
}

async function connect(c: Context, row: TripRow, account: GitHubUser): Promise<string> {
  const { session, user } = await tripSession(c, row);
  await connectGitHub(c, session, user, account);
  return '/account/security/?github=connected';
}

async function reauth(c: Context, row: TripRow, account: GitHubUser): Promise<string> {
  const { session, user } = await tripSession(c, row);
  if ((await connectedGitHub(c, user.id))?.github_id !== account.id) throw new TripError('mismatch');
  await touch(c, account);
  await rotateSession(c, session, { reauth: true });
  return withParams(row.next, { github: 'confirmed' });
}

/** The GitHub account that came back without an account to sign in to: a sign-up waiting for the Terms, or a link waiting for the owner. */
async function pending(c: Context, purpose: 'sign-up' | 'link'): Promise<TripRow> {
  const token = readCookie(c.request, GITHUB_COOKIE);
  const row =
    token && token.length <= 100
      ? await c.env.DB.prepare('SELECT * FROM github_states WHERE token_hash = ? AND purpose = ? AND expires_at > ?').bind(await sha256(token), purpose, Date.now()).first<TripRow>()
      : null;
  if (!row) throw new HttpError(401, 'github_expired', 'Your GitHub sign-in expired. Start again.');
  return row;
}

/** GET /api/account/github/sign-up and GET /api/account/github/link */
export async function pendingDetails(c: Context, purpose: 'sign-up' | 'link'): Promise<Response> {
  const row = await pending(c, purpose);
  return ok({ login: row.login, email: row.email });
}

/** POST /api/account/github/link, once the owner of the email signs in: connects the GitHub account that came back with it. */
export async function link(c: Context): Promise<Response> {
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  const row = await pending(c, 'link');
  if (row.user_id !== user.id) throw new HttpError(409, 'other_account', 'You signed in to another account. Connect GitHub on the Security page.');
  await c.env.DB.prepare('DELETE FROM github_states WHERE token_hash = ?').bind(row.token_hash).run();
  c.cookies.push(clearCookie(GITHUB_COOKIE));
  await connectGitHub(c, session, user, { id: row.github_id!, login: row.login! });
  return ok();
}

/** POST /api/account/github/sign-up with the Terms box: a verified account with GitHub connected and no password. */
export async function signUp(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'sign-up');
  const row = await pending(c, 'sign-up');
  requireTerms(body);
  const id = randomId();
  const now = Date.now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO users (id, email, email_verified_at, password_hash, webauthn_user_id, created_at, updated_at, terms_version, terms_accepted_at) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)",
      ).bind(id, row.email, now, randomToken(32), now, now, TERMS_VERSION, now),
      c.env.DB.prepare('INSERT INTO github_accounts (user_id, github_id, login, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)').bind(id, row.github_id, row.login, now, now),
      c.env.DB.prepare('DELETE FROM github_states WHERE token_hash = ?').bind(row.token_hash),
    ]);
  } catch (error) {
    const message = (error as Error)?.message ?? '';
    if (/UNIQUE.*github_id/i.test(message)) throw new HttpError(409, 'github_taken', 'This GitHub account already has a pi-rust account. Sign in with GitHub.');
    if (/UNIQUE/i.test(message)) {
      throw new HttpError(409, 'email_taken', 'A pi-rust account already uses the email of your GitHub account. Sign in with GitHub again to connect it.');
    }
    throw error;
  }
  c.cookies.push(clearCookie(GITHUB_COOKIE));
  await startSession(c, (await userById(c, id))!, { reauth: true });
  return ok({ next: 'done' });
}

/** DELETE /api/account/github, after a recent confirmation. The account must keep a password or a passkey. */
export async function disconnect(c: Context): Promise<Response> {
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  if (!user.password_hash && (await passkeyCount(c, user.id)) === 0) {
    throw new HttpError(409, 'last_sign_in_method', 'Set a password or add a passkey before you disconnect GitHub.');
  }
  const row = await c.env.DB.prepare('DELETE FROM github_accounts WHERE user_id = ? RETURNING login').bind(user.id).first<{ login: string }>();
  if (!row) throw new HttpError(404, 'not_found', 'GitHub is not connected.');
  await rotateSession(c, session);
  sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'github-disconnected', login: row.login, resetLink: resetLink(c) });
  return ok();
}
