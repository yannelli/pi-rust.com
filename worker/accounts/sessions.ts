// Browser sessions: a 256-bit token in the __Host-pirs_session cookie, its SHA-256 in D1,
// 30-day sliding expiry, rotation on sign-in and privilege changes, and recent re-authentication.

import { userById, type Context, type SessionRow, type User } from './context';
import { randomId, randomToken, sha256 } from './crypto';
import { clearCookie, deviceLabel, HttpError, readCookie, setCookie } from './http';

export const SESSION_COOKIE = '__Host-pirs_session';
const DAY = 24 * 60 * 60 * 1000;
export const SESSION_TTL = 30 * DAY;
/** How long a password or passkey confirmation unlocks sensitive actions. */
export const REAUTH_WINDOW = 10 * 60 * 1000;
/** last_seen_at and the sliding expiry are written at most this often. */
const TOUCH_EVERY = 5 * 60 * 1000;

function sessionCookie(c: Context, token: string): void {
  c.cookies.push(setCookie(SESSION_COOKIE, token, SESSION_TTL / 1000));
}

/** A suspended account gets this error after a correct password or passkey, and nothing else. */
export function refuseSuspended(user: User): void {
  if (user.suspended_at) throw new HttpError(403, 'account_suspended', 'This account is suspended.');
}

/** Starts a new session for a user who just signed in; ends the session the browser had before. */
export async function startSession(c: Context, user: User, options: { reauth: boolean }): Promise<void> {
  refuseSuspended(user);
  const previous = readCookie(c.request, SESSION_COOKIE);
  const token = randomToken();
  const now = Date.now();
  const statements = [
    c.env.DB.prepare(
      'INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, last_seen_at, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(randomId(), user.id, await sha256(token), deviceLabel(c.request.headers.get('User-Agent')), now, now, now + SESSION_TTL, options.reauth ? now : null),
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
  ];
  if (previous) statements.push(c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(previous)));
  await c.env.DB.batch(statements);
  sessionCookie(c, token);
  c.auth = undefined;
}

/** The signed-in session and user, or null. Extends the session when it was last seen over 5 minutes ago. */
export async function loadSession(c: Context): Promise<{ session: SessionRow; user: User } | null> {
  if (c.auth !== undefined) return c.auth;
  c.auth = null;
  const token = readCookie(c.request, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const session = await c.env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(await sha256(token)).first<SessionRow>();
  const now = Date.now();
  if (!session || session.expires_at < now) return null;
  const user = await userById(c, session.user_id);
  if (!user || user.suspended_at) return null;
  if (now - session.last_seen_at > TOUCH_EVERY) {
    session.last_seen_at = now;
    session.expires_at = now + SESSION_TTL;
    await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').bind(now, session.expires_at, session.id).run();
    sessionCookie(c, token);
  }
  c.auth = { session, user };
  return c.auth;
}

export async function requireSession(c: Context): Promise<{ session: SessionRow; user: User }> {
  const auth = await loadSession(c);
  if (!auth) throw new HttpError(401, 'unauthorized', 'Sign in to continue.');
  return auth;
}

/** Sign in again is needed for this action when the last confirmation is over 10 minutes old. */
export function requireRecentAuth(session: SessionRow): void {
  if (!session.reauth_at || Date.now() - session.reauth_at > REAUTH_WINDOW) {
    throw new HttpError(403, 'reauth_required', 'Confirm it’s you to continue.');
  }
}

/** Gives the current session a new token, after a privilege change. `reauth` also records a fresh confirmation. */
export async function rotateSession(c: Context, session: SessionRow, options: { reauth?: boolean } = {}): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  if (options.reauth) session.reauth_at = now;
  await c.env.DB.prepare('UPDATE sessions SET token_hash = ?, reauth_at = ?, last_seen_at = ?, expires_at = ? WHERE id = ?')
    .bind(await sha256(token), session.reauth_at, now, now + SESSION_TTL, session.id)
    .run();
  sessionCookie(c, token);
}

export async function endSession(c: Context): Promise<void> {
  const token = readCookie(c.request, SESSION_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  c.cookies.push(clearCookie(SESSION_COOKIE));
  c.auth = null;
}
