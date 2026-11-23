// Changing the email address of an account:
//
// 1. POST /api/account/email/change, signed in with a confirmation from the last 10 minutes. The new address
//    gets a link (24 hours); the old one gets a notice. Until the link is opened, nothing changes, and a
//    password change or reset cancels the request. The answer and the account page are the same when the
//    new address already has an account; that address then gets a notice instead of a link.
// 2. POST /api/account/email/confirm with the link's token makes the change. The new address counts as
//    verified, links sent to the old address stop working, and the old address gets an undo link (7 days).
// 3. POST /api/account/email/undo with that token puts the old address back, signs out everywhere, replaces
//    the password with an unknown one, removes passkeys and two-step verification added since the change was
//    asked for, and sends a link to set a new password. So someone who took over an account and moved it to
//    their own address cannot keep it.
//
// See docs/accounts.md.

import { dropRecoveryCodesIfUnused, emailLink, pepper, resetLink } from './common';
import { userByEmail, userById, type Context, type User } from './context';
import { hashPassword, randomToken, sha256 } from './crypto';
import { sendEmail } from './email';
import { clearCookie, HttpError, isEmail, limitAuth, normalizeEmail, ok, str, type Json } from './http';
import { loadSession, requireRecentAuth, requireSession, rotateSession, SESSION_COOKIE } from './sessions';

const HOUR = 60 * 60 * 1000;
const CONFIRM_TTL = 24 * HOUR;
const UNDO_TTL = 7 * 24 * HOUR;

interface EmailChangeRow {
  token_hash: string;
  user_id: string;
  purpose: 'confirm' | 'undo';
  old_email: string;
  new_email: string;
  requested_at: number;
}

const invalidLink = () => new HttpError(400, 'invalid_token', 'This link has expired or was already used.');

/** The address waiting for confirmation, or null. */
export async function pendingEmail(c: Context, userId: string): Promise<string | null> {
  const row = await c.env.DB.prepare(
    "SELECT new_email FROM email_changes WHERE user_id = ? AND purpose = 'confirm' AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(userId, Date.now())
    .first<{ new_email: string }>();
  return row?.new_email ?? null;
}

/** Ends a waiting change: after a password change or reset, and on "Cancel". */
export function cancelPendingStatement(c: Context, userId: string) {
  return c.env.DB.prepare("DELETE FROM email_changes WHERE user_id = ? AND purpose = 'confirm'").bind(userId);
}

/** POST /api/account/email/change with `{"email"}`, after a recent confirmation. */
export async function requestChange(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'email');
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  const email = normalizeEmail(str(body, 'email', 320));
  if (!isEmail(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.', { field: 'email' });
  if (email === user.email) throw new HttpError(400, 'same_email', 'That is already your email address.', { field: 'email' });
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.batch([
    cancelPendingStatement(c, user.id),
    c.env.DB.prepare(
      "INSERT INTO email_changes (token_hash, user_id, purpose, old_email, new_email, requested_at, created_at, expires_at) VALUES (?, ?, 'confirm', ?, ?, ?, ?, ?)",
    ).bind(await sha256(token), user.id, user.email, email, now, now, now + CONFIRM_TTL),
  ]);
  const taken = await userByEmail(c, email);
  if (taken) {
    sendEmail(c.env, c.request, c.ctx, email, { kind: 'email-change-taken' });
  } else {
    sendEmail(c.env, c.request, c.ctx, email, { kind: 'email-change', link: `${c.origin}/account/confirm-email/#token=${token}` });
  }
  sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'email-change-requested', newEmail: email, resetLink: resetLink(c) });
  return ok({ pendingEmail: email });
}

/** POST /api/account/email/change/cancel */
export async function cancelChange(c: Context): Promise<Response> {
  const { user } = await requireSession(c);
  await cancelPendingStatement(c, user.id).run();
  return ok();
}

/** The unused, unexpired row for a token, and its account, without using it up. */
async function findChange(c: Context, token: string, purpose: EmailChangeRow['purpose']): Promise<{ row: EmailChangeRow; user: User }> {
  if (!token || token.length > 100) throw invalidLink();
  const row = await c.env.DB.prepare('SELECT * FROM email_changes WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?')
    .bind(await sha256(token), purpose, Date.now())
    .first<EmailChangeRow>();
  const user = row ? await userById(c, row.user_id) : null;
  if (!row || !user) throw invalidLink();
  if (user.suspended_at) throw new HttpError(403, 'account_suspended', 'This account is suspended.');
  return { row, user };
}

/** Marks the row used. Fails when another request used it first. */
async function useChange(c: Context, row: EmailChangeRow): Promise<void> {
  const result = await c.env.DB.prepare('UPDATE email_changes SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(Date.now(), row.token_hash).run();
  if (result.meta.changes !== 1) throw invalidLink();
}

/** Throws when `email` belongs to an account other than `userId`. */
async function requireFree(c: Context, email: string, userId: string): Promise<void> {
  const owner = await userByEmail(c, email);
  if (owner && owner.id !== userId) throw new HttpError(409, 'email_taken', 'That address has another pi-rust account now.');
}

/** POST /api/account/email/confirm with the token from the link sent to the new address. */
export async function confirmChange(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'verify');
  const { row, user } = await findChange(c, str(body, 'token', 200), 'confirm');
  // A change asked for under an address the account no longer has is stale.
  if (user.email !== row.old_email) throw invalidLink();
  await requireFree(c, row.new_email, user.id);
  await useChange(c, row);
  const undo = randomToken();
  const now = Date.now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE users SET email = ?, email_verified_at = ?, updated_at = ? WHERE id = ? AND email = ?').bind(row.new_email, now, now, user.id, row.old_email),
      // Verify and reset links went to the old address.
      c.env.DB.prepare('DELETE FROM email_tokens WHERE user_id = ?').bind(user.id),
      cancelPendingStatement(c, user.id),
      c.env.DB.prepare(
        "INSERT INTO email_changes (token_hash, user_id, purpose, old_email, new_email, requested_at, created_at, expires_at) VALUES (?, ?, 'undo', ?, ?, ?, ?, ?)",
      ).bind(await sha256(undo), user.id, row.old_email, row.new_email, row.requested_at, now, now + UNDO_TTL),
    ]);
  } catch (error) {
    // The UNIQUE email column: another account took the address a moment ago.
    if (/UNIQUE/i.test((error as Error)?.message ?? '')) throw new HttpError(409, 'email_taken', 'That address has another pi-rust account now.');
    throw error;
  }
  sendEmail(c.env, c.request, c.ctx, row.old_email, { kind: 'email-changed', newEmail: row.new_email, undoLink: `${c.origin}/account/undo-email/#token=${undo}` });
  const auth = await loadSession(c);
  const signedIn = Boolean(auth && auth.user.id === user.id);
  if (auth && signedIn) await rotateSession(c, auth.session);
  return ok({ email: row.new_email, signedIn });
}

/** POST /api/account/email/undo with the token from the link sent to the old address. */
export async function undoChange(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'reset');
  const { row, user } = await findChange(c, str(body, 'token', 200), 'undo');
  await requireFree(c, row.old_email, user.id);
  // Hashed before the token is used up, so a missing pepper fails without spending the link.
  const unknownPassword = await hashPassword(randomToken(), pepper(c));
  await useChange(c, row);
  const now = Date.now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE users SET email = ?, email_verified_at = ?, password_hash = ?, updated_at = ? WHERE id = ?').bind(row.old_email, now, unknownPassword, now, user.id),
      // Two-step verification turned on since the change was asked for goes; the owner's own stays.
      c.env.DB.prepare(
        'UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ? AND totp_enabled_at >= ?',
      ).bind(user.id, row.requested_at),
      c.env.DB.prepare('DELETE FROM passkeys WHERE user_id = ? AND created_at >= ?').bind(user.id, row.requested_at),
      ...['sessions', 'cli_tokens', 'sign_in_challenges', 'webauthn_challenges', 'device_codes', 'email_tokens', 'email_changes'].map((table) =>
        c.env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(user.id),
      ),
    ]);
  } catch (error) {
    if (/UNIQUE/i.test((error as Error)?.message ?? '')) throw new HttpError(409, 'email_taken', 'That address has another pi-rust account now.');
    throw error;
  }
  await dropRecoveryCodesIfUnused(c, user.id);
  // Every session is gone, this browser's too.
  c.cookies.push(clearCookie(SESSION_COOKIE));
  const restored = (await userById(c, user.id))!;
  sendEmail(c.env, c.request, c.ctx, restored.email, { kind: 'email-change-undone', resetLink: await emailLink(c, restored, 'reset') });
  return ok({ email: restored.email });
}
