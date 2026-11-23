// Sign-up, sign-in (password, second step, passkey), sign-out, email verification, password reset,
// and re-authentication.

import {
  pepper,
  totpKey,
  checkNewPassword,
  emailLink,
  findEmailToken,
  useEmailToken,
  resetLink,
  useRecoveryCode,
  recoveryCodesLeft,
  passkeyCount,
  requireTerms,
  type EmailTokenRow,
} from './common';
import { isoTime, userByEmail, userById, type Context, type User } from './context';
import { decryptSecret, DUMMY_PASSWORD_HASH, hashPassword, passwordNeedsRehash, randomId, randomToken, sha256, verifyPassword } from './crypto';
import { sendEmail } from './email';
import { cancelPendingStatement } from './email-change';
import { connectedGitHub } from './github';
import { clearCookie, HttpError, isEmail, limitAuth, normalizeEmail, ok, readCookie, setCookie, str, type Json } from './http';
import { authenticate, authenticationOptions } from './passkeys';
import { endSession, loadSession, refuseSuspended, requireSession, rotateSession, startSession } from './sessions';
import { matchTotp } from './totp';
import { TERMS_VERSION } from '../../src/lib/legal';

export type SecondStepMethods = { totp: boolean; passkey: boolean; recovery: boolean };

export const SIGN_IN_COOKIE = '__Host-pirs_signin';
const SECOND_STEP_TTL = 10 * 60 * 1000;
const SECOND_STEP_ATTEMPTS = 5;

function readEmail(body: Json): string {
  const email = normalizeEmail(str(body, 'email', 320));
  if (!isEmail(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.', { field: 'email' });
  return email;
}

/** POST /api/account/sign-up. The reply is the same whether or not the address has an account. */
export async function signUp(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'sign-up');
  const email = readEmail(body);
  const password = str(body, 'password', 1024);
  checkNewPassword(password, email);
  requireTerms(body);
  const key = pepper(c);
  const existing = await userByEmail(c, email);
  if (existing) {
    // Spend the time a new account would take hashing its password.
    await verifyPassword(password, DUMMY_PASSWORD_HASH, key);
    sendEmail(c.env, c.request, c.ctx, existing.email, { kind: 'sign-up-existing', signInLink: `${c.origin}/account/sign-in/`, resetLink: resetLink(c) });
    return ok({ next: 'check_email' });
  }
  const now = Date.now();
  const user: User = {
    id: randomId(),
    email,
    email_verified_at: null,
    password_hash: await hashPassword(password, key),
    totp_secret: null,
    totp_pending: null,
    totp_enabled_at: null,
    totp_last_step: null,
    webauthn_user_id: randomToken(32),
    created_at: now,
    updated_at: now,
    role: 'user',
    suspended_at: null,
  };
  try {
    await c.env.DB.prepare(
      'INSERT INTO users (id, email, password_hash, webauthn_user_id, created_at, updated_at, terms_version, terms_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(user.id, user.email, user.password_hash, user.webauthn_user_id, now, now, TERMS_VERSION, now)
      .run();
  } catch (error) {
    // Another request created this address a moment ago; answer as for any existing address.
    if (await userByEmail(c, email)) return ok({ next: 'check_email' });
    throw error;
  }
  sendEmail(c.env, c.request, c.ctx, email, { kind: 'verify', link: await emailLink(c, user, 'verify') });
  return ok({ next: 'check_email' });
}

export async function hasSecondStep(c: Context, user: User): Promise<SecondStepMethods | undefined> {
  const passkeys = await passkeyCount(c, user.id);
  if (!user.totp_enabled_at && passkeys === 0) return undefined;
  return { totp: Boolean(user.totp_enabled_at), passkey: passkeys > 0, recovery: (await recoveryCodesLeft(c, user.id)) > 0 };
}

/** After the first step (a password or GitHub), a sign-in challenge waits for the second step for 10 minutes. */
export async function startSecondStep(c: Context, user: User): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sign_in_challenges WHERE expires_at < ?').bind(now),
    c.env.DB.prepare('INSERT INTO sign_in_challenges (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(
      await sha256(token),
      user.id,
      now,
      now + SECOND_STEP_TTL,
    ),
  ]);
  c.cookies.push(setCookie(SIGN_IN_COOKIE, token, SECOND_STEP_TTL / 1000));
}

/** POST /api/account/sign-in with email and password. With two-step on, it starts the second step instead. */
export async function signIn(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'sign-in');
  const email = normalizeEmail(str(body, 'email', 320));
  const password = str(body, 'password', 1024);
  const key = pepper(c);
  const user = isEmail(email) ? await userByEmail(c, email) : null;
  // An account made with GitHub has no password (''); the dummy hash keeps the timing the same.
  const valid = await verifyPassword(password, user?.password_hash || DUMMY_PASSWORD_HASH, key);
  if (!user || !valid) throw new HttpError(401, 'invalid_credentials', 'Wrong email or password.');
  if (passwordNeedsRehash(user.password_hash)) {
    await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(await hashPassword(password, key), Date.now(), user.id).run();
  }
  refuseSuspended(user);
  const methods = await hasSecondStep(c, user);
  if (methods) {
    await startSecondStep(c, user);
    return ok({ next: 'two_step', methods });
  }
  await startSession(c, user, { reauth: true });
  return ok({ next: 'done' });
}

interface PendingSignIn {
  token_hash: string;
  user: User;
  attempts: number;
}

async function pendingSignIn(c: Context): Promise<PendingSignIn> {
  const token = readCookie(c.request, SIGN_IN_COOKIE);
  const expired = new HttpError(401, 'sign_in_expired', 'Your sign-in expired. Start again.');
  if (!token || token.length > 100) throw expired;
  const row = await c.env.DB.prepare('SELECT token_hash, user_id, attempts, expires_at FROM sign_in_challenges WHERE token_hash = ?')
    .bind(await sha256(token))
    .first<{ token_hash: string; user_id: string; attempts: number; expires_at: number }>();
  if (!row || row.expires_at < Date.now() || row.attempts >= SECOND_STEP_ATTEMPTS) throw expired;
  const user = await userById(c, row.user_id);
  if (!user) throw expired;
  return { token_hash: row.token_hash, user, attempts: row.attempts };
}

/** Counts a wrong code. After 5, the sign-in starts over. */
async function wrongCode(c: Context, pending: PendingSignIn, description: string): Promise<never> {
  if (pending.attempts + 1 >= SECOND_STEP_ATTEMPTS) {
    await c.env.DB.prepare('DELETE FROM sign_in_challenges WHERE token_hash = ?').bind(pending.token_hash).run();
    c.cookies.push(clearCookie(SIGN_IN_COOKIE));
    throw new HttpError(401, 'sign_in_expired', 'Too many wrong codes. Start again.');
  }
  await c.env.DB.prepare('UPDATE sign_in_challenges SET attempts = attempts + 1 WHERE token_hash = ?').bind(pending.token_hash).run();
  throw new HttpError(401, 'invalid_code', description, { field: 'code' });
}

async function finishSignIn(c: Context, pending: PendingSignIn): Promise<Response> {
  const removed = await c.env.DB.prepare('DELETE FROM sign_in_challenges WHERE token_hash = ?').bind(pending.token_hash).run();
  if (removed.meta.changes !== 1) throw new HttpError(401, 'sign_in_expired', 'Your sign-in expired. Start again.');
  c.cookies.push(clearCookie(SIGN_IN_COOKIE));
  await startSession(c, pending.user, { reauth: true });
  return ok({ next: 'done' });
}

/** Accepts a TOTP code for a user, once per time step. */
export async function acceptTotp(c: Context, user: User, code: string): Promise<boolean> {
  if (!user.totp_secret) return false;
  const secret = await decryptSecret(user.totp_secret, totpKey(c), user.id);
  const step = await matchTotp(secret, code, user.totp_last_step);
  if (step === undefined) return false;
  const result = await c.env.DB.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)')
    .bind(step, user.id, step)
    .run();
  return result.meta.changes === 1;
}

/** POST /api/account/sign-in/totp */
export async function signInTotp(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'two-step');
  const pending = await pendingSignIn(c);
  if (!pending.user.totp_enabled_at || !(await acceptTotp(c, pending.user, str(body, 'code', 20)))) {
    return wrongCode(c, pending, 'Wrong code. Try again.');
  }
  return finishSignIn(c, pending);
}

/** POST /api/account/sign-in/recovery */
export async function signInRecovery(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'two-step');
  const pending = await pendingSignIn(c);
  if (!(await useRecoveryCode(c, pending.user.id, str(body, 'code', 40)))) return wrongCode(c, pending, 'Wrong or used recovery code.');
  const left = await recoveryCodesLeft(c, pending.user.id);
  sendEmail(c.env, c.request, c.ctx, pending.user.email, { kind: 'recovery-code-used', left, resetLink: resetLink(c) });
  return finishSignIn(c, pending);
}

/** POST /api/account/sign-in/passkey/options: passwordless, or the second step when a password sign-in is pending. */
export async function signInPasskeyOptions(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'passkey');
  if (body.secondStep === true) {
    const pending = await pendingSignIn(c);
    return ok(await authenticationOptions(c, 'second-factor', pending.user));
  }
  return ok(await authenticationOptions(c, 'sign-in', null));
}

/** POST /api/account/sign-in/passkey */
export async function signInPasskey(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'passkey');
  if (body.secondStep === true) {
    const pending = await pendingSignIn(c);
    await authenticate(c, 'second-factor', pending.user, body.ceremony, body.response);
    return finishSignIn(c, pending);
  }
  const passkey = await authenticate(c, 'sign-in', null, body.ceremony, body.response);
  const user = await userById(c, passkey.user_id);
  if (!user) throw new HttpError(400, 'invalid_passkey', 'That passkey did not work.');
  await startSession(c, user, { reauth: true });
  return ok({ next: 'done' });
}

/** POST /api/account/sign-out */
export async function signOut(c: Context): Promise<Response> {
  await endSession(c);
  return ok();
}

/** POST /api/account/verify with the token from the email link. */
export async function verifyEmail(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'verify');
  const row = await findEmailToken(c, str(body, 'token', 200), 'verify');
  const user = await userById(c, row.user_id);
  if (!user || user.email !== row.email) throw new HttpError(400, 'invalid_token', 'This link has expired or was already used.');
  await useEmailToken(c, row);
  if (!user.email_verified_at) {
    await c.env.DB.prepare('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?').bind(Date.now(), Date.now(), user.id).run();
  }
  // Verifying grants sharing and CLI sign-in, so a session in this browser gets a new token.
  const auth = await loadSession(c);
  if (auth && auth.user.id === user.id) await rotateSession(c, auth.session);
  return ok({ signedIn: Boolean(auth && auth.user.id === user.id) });
}

/** POST /api/account/verify/resend, signed in. */
export async function resendVerification(c: Context): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'verify');
  const { user } = await requireSession(c);
  if (user.email_verified_at) return ok({ verified: true });
  sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'verify', link: await emailLink(c, user, 'verify') });
  return ok({ verified: false });
}

/** POST /api/account/reset/request. The reply is the same whether or not the address has an account. */
export async function requestReset(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'reset');
  const email = readEmail(body);
  const user = await userByEmail(c, email);
  if (user) sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'reset', link: await emailLink(c, user, 'reset') });
  return ok({ next: 'check_email' });
}

/** The account of an unused reset link, without using it up. */
async function resetTarget(c: Context, body: Json): Promise<{ row: EmailTokenRow; user: User }> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'reset');
  const row = await findEmailToken(c, str(body, 'token', 200), 'reset');
  const user = await userById(c, row.user_id);
  if (!user || user.email !== row.email) throw new HttpError(400, 'invalid_token', 'This link has expired or was already used.');
  return { row, user };
}

/**
 * POST /api/account/reset/check with the token from the email link: whether it works, and the GitHub account
 * that can sign in, so the owner can disconnect it with the reset (docs/accounts.md, "Resetting the Password").
 */
export async function checkReset(c: Context, body: Json): Promise<Response> {
  const { user } = await resetTarget(c, body);
  const github = await connectedGitHub(c, user.id);
  return ok({ github: github ? { login: github.login, connectedAt: isoTime(github.created_at) } : null });
}

/**
 * POST /api/account/reset with the token from the email link and a new password. Signs out everywhere. A
 * connected GitHub account stays unless `disconnectGitHub` is true; the email says it can still sign in.
 */
export async function resetPassword(c: Context, body: Json): Promise<Response> {
  const { row, user } = await resetTarget(c, body);
  const password = str(body, 'password', 1024);
  checkNewPassword(password, user.email);
  const hash = await hashPassword(password, pepper(c));
  const github = await connectedGitHub(c, user.id);
  const disconnectGitHub = Boolean(github) && body.disconnectGitHub === true;
  await useEmailToken(c, row);
  const now = Date.now();
  await c.env.DB.batch([
    // The link proves the address, so it also counts as verification.
    c.env.DB.prepare('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?').bind(hash, now, now, user.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM cli_tokens WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM sign_in_challenges WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'reset'").bind(user.id),
    c.env.DB.prepare('DELETE FROM github_states WHERE user_id = ?').bind(user.id),
    // The reset link went to the account's address, so a waiting email change, perhaps someone else's, ends.
    cancelPendingStatement(c, user.id),
    ...(disconnectGitHub ? [c.env.DB.prepare('DELETE FROM github_accounts WHERE user_id = ?').bind(user.id)] : []),
  ]);
  c.cookies.push(clearCookie(SIGN_IN_COOKIE));
  if (github && disconnectGitHub) sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'github-disconnected', login: github.login, resetLink: resetLink(c) });
  sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'password-changed', resetLink: resetLink(c), github: disconnectGitHub ? undefined : github?.login });
  return ok({ next: 'sign_in' });
}

/** POST /api/account/reauth with the password: unlocks sensitive actions for 10 minutes. */
export async function reauthPassword(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'reauth');
  const { session, user } = await requireSession(c);
  if (!(await verifyPassword(str(body, 'password', 1024), user.password_hash || DUMMY_PASSWORD_HASH, pepper(c)))) {
    throw new HttpError(401, 'invalid_credentials', 'Wrong password.', { field: 'password' });
  }
  await rotateSession(c, session, { reauth: true });
  return ok();
}

/** POST /api/account/reauth/passkey/options */
export async function reauthPasskeyOptions(c: Context): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'reauth');
  const { user } = await requireSession(c);
  return ok(await authenticationOptions(c, 'reauth', user));
}

/** POST /api/account/reauth/passkey */
export async function reauthPasskey(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'reauth');
  const { session, user } = await requireSession(c);
  await authenticate(c, 'reauth', user, body.ceremony, body.response);
  await rotateSession(c, session, { reauth: true });
  return ok();
}

