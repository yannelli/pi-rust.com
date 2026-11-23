// Signed-in account endpoints: the account summary, password, two-step verification, recovery codes,
// passkeys, sessions, CLI tokens, shares, and account deletion.

import {
  checkNewPassword,
  dropRecoveryCodesIfUnused,
  newRecoveryCodes,
  passkeyCount,
  pepper,
  recoveryCodesLeft,
  resetLink,
  totpKey,
} from './common';
import { isoTime, type Context } from './context';
import { cancelPendingStatement, pendingEmail } from './email-change';
import type { AccountEnv } from './env';
import { decryptSecret, encryptSecret, hashPassword } from './crypto';
import { sendEmail } from './email';
import { clearCookie, HttpError, limitAuth, ok, str, type Json } from './http';
import { defaultPasskeyName, passkeysOf, register, registrationOptions } from './passkeys';
import { REAUTH_WINDOW, requireRecentAuth, requireSession, rotateSession, SESSION_COOKIE } from './sessions';
import { matchTotp, newTotpSecret, otpauthUri, base32Encode } from './totp';
import { deleteShares, listShares } from '../share/store';

/** GET /api/account/me */
export async function me(c: Context): Promise<Response> {
  const { session, user } = await requireSession(c);
  return ok({
    account: {
      email: user.email,
      verified: Boolean(user.email_verified_at),
      createdAt: isoTime(user.created_at),
      totp: Boolean(user.totp_enabled_at),
      passkeys: await passkeyCount(c, user.id),
      recoveryCodes: await recoveryCodesLeft(c, user.id),
      admin: user.role === 'admin',
      pendingEmail: await pendingEmail(c, user.id),
    },
    session: { reauthUntil: session.reauth_at ? isoTime(session.reauth_at + REAUTH_WINDOW) : null },
  });
}

/** POST /api/account/password: a new password, after a recent confirmation. Signs out other sessions. */
export async function changePassword(c: Context, body: Json): Promise<Response> {
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  const password = str(body, 'password', 1024);
  checkNewPassword(password, user.email);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(await hashPassword(password, pepper(c)), now, user.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.id, session.id),
    c.env.DB.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'reset'").bind(user.id),
    // A waiting email change could be someone else's; a new password ends it.
    cancelPendingStatement(c, user.id),
  ]);
  await rotateSession(c, session);
  sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'password-changed', resetLink: resetLink(c) });
  return ok();
}

/** POST /api/account/totp/setup: a new secret to scan. It is used only after a code confirms it. */
export async function totpSetup(c: Context): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'two-step');
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  if (user.totp_enabled_at) throw new HttpError(409, 'totp_enabled', 'Two-step verification is already on.');
  const secret = newTotpSecret();
  await c.env.DB.prepare('UPDATE users SET totp_pending = ?, updated_at = ? WHERE id = ?')
    .bind(await encryptSecret(secret, totpKey(c), user.id), Date.now(), user.id)
    .run();
  return ok({ secret: base32Encode(secret), uri: otpauthUri(secret, user.email) });
}

/** POST /api/account/totp/enable with the first code. Returns new recovery codes. */
export async function totpEnable(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'two-step');
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  if (user.totp_enabled_at) throw new HttpError(409, 'totp_enabled', 'Two-step verification is already on.');
  if (!user.totp_pending) throw new HttpError(400, 'totp_not_started', 'Start again to get a new code.');
  const secret = await decryptSecret(user.totp_pending, totpKey(c), user.id);
  const step = await matchTotp(secret, str(body, 'code', 20), null);
  if (step === undefined) throw new HttpError(400, 'invalid_code', 'Wrong code. Try again.', { field: 'code' });
  const now = Date.now();
  const result = await c.env.DB.prepare(
    'UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = ?, totp_last_step = ?, updated_at = ? WHERE id = ? AND totp_pending = ?',
  )
    .bind(now, step, now, user.id, user.totp_pending)
    .run();
  if (result.meta.changes !== 1) throw new HttpError(409, 'totp_not_started', 'Start again to get a new code.');
  const codes = await newRecoveryCodes(c, user.id);
  await rotateSession(c, session);
  sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'two-step-on', resetLink: resetLink(c) });
  return ok({ recoveryCodes: codes });
}

/** POST /api/account/totp/disable, after a recent confirmation. */
export async function totpDisable(c: Context): Promise<Response> {
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  if (!user.totp_enabled_at) return ok();
  await c.env.DB.prepare(
    'UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?',
  )
    .bind(Date.now(), user.id)
    .run();
  await dropRecoveryCodesIfUnused(c, user.id);
  await rotateSession(c, session);
  sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'two-step-off', resetLink: resetLink(c) });
  return ok();
}

/** POST /api/account/recovery-codes: replaces the codes, after a recent confirmation. */
export async function regenerateRecoveryCodes(c: Context): Promise<Response> {
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  if (!user.totp_enabled_at && (await passkeyCount(c, user.id)) === 0) {
    throw new HttpError(400, 'no_two_step', 'Turn on two-step verification or add a passkey first.');
  }
  return ok({ recoveryCodes: await newRecoveryCodes(c, user.id) });
}

/** GET /api/account/passkeys */
export async function listPasskeys(c: Context): Promise<Response> {
  const { user } = await requireSession(c);
  const rows = await passkeysOf(c, user.id);
  return ok({
    passkeys: rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: isoTime(row.created_at),
      lastUsedAt: isoTime(row.last_used_at),
      backedUp: row.backed_up === 1,
    })),
  });
}

/** POST /api/account/passkeys/options, after a recent confirmation. */
export async function passkeyRegistrationOptions(c: Context): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'passkey');
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  return ok(await registrationOptions(c, user));
}

const passkeyName = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64);

/** POST /api/account/passkeys: stores a new passkey. The first second step also gets recovery codes. */
export async function addPasskey(c: Context, body: Json): Promise<Response> {
  await limitAuth(c.env.AUTH_LIMITER, c.request, 'passkey');
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  const name = passkeyName(str(body, 'name', 200)) || defaultPasskeyName(session.user_agent);
  const row = await register(c, user, body.ceremony, body.response, name);
  const codes = !user.totp_enabled_at && (await recoveryCodesLeft(c, user.id)) === 0 ? await newRecoveryCodes(c, user.id) : undefined;
  await rotateSession(c, session);
  sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'passkey-added', name: row.name, resetLink: resetLink(c) });
  return ok({ passkey: { id: row.id, name: row.name, createdAt: isoTime(row.created_at) }, ...(codes ? { recoveryCodes: codes } : {}) });
}

/** PATCH /api/account/passkeys/<id> with a new name. */
export async function renamePasskey(c: Context, id: string, body: Json): Promise<Response> {
  const { user } = await requireSession(c);
  const name = passkeyName(str(body, 'name', 200));
  if (!name) throw new HttpError(400, 'invalid_name', 'Enter a name.', { field: 'name' });
  const result = await c.env.DB.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?').bind(name, id, user.id).run();
  if (result.meta.changes !== 1) throw new HttpError(404, 'not_found', 'No such passkey.');
  return ok({ passkey: { id, name } });
}

/** DELETE /api/account/passkeys/<id>, after a recent confirmation. */
export async function removePasskey(c: Context, id: string): Promise<Response> {
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  const row = await c.env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ? RETURNING name').bind(id, user.id).first<{ name: string }>();
  if (!row) throw new HttpError(404, 'not_found', 'No such passkey.');
  await dropRecoveryCodesIfUnused(c, user.id);
  await rotateSession(c, session);
  sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'passkey-removed', name: row.name, resetLink: resetLink(c) });
  return ok();
}

/** GET /api/account/sessions: browser sessions. */
export async function listSessions(c: Context): Promise<Response> {
  const { session, user } = await requireSession(c);
  const { results } = await c.env.DB.prepare('SELECT id, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC')
    .bind(user.id, Date.now())
    .all<{ id: string; user_agent: string; created_at: number; last_seen_at: number }>();
  return ok({
    sessions: results.map((row) => ({
      id: row.id,
      label: row.user_agent,
      createdAt: isoTime(row.created_at),
      lastSeenAt: isoTime(row.last_seen_at),
      current: row.id === session.id,
    })),
  });
}

/** DELETE /api/account/sessions/<id>. Ending the current session signs out. */
export async function revokeSession(c: Context, id: string): Promise<Response> {
  const { session, user } = await requireSession(c);
  const result = await c.env.DB.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  if (result.meta.changes !== 1) throw new HttpError(404, 'not_found', 'No such session.');
  if (id === session.id) c.cookies.push(clearCookie(SESSION_COOKIE));
  return ok({ signedOut: id === session.id });
}

/** POST /api/account/sessions/revoke-others, after a recent confirmation. */
export async function revokeOtherSessions(c: Context): Promise<Response> {
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  const result = await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.id, session.id).run();
  return ok({ revoked: result.meta.changes });
}

/** GET /api/account/tokens: CLI tokens. */
export async function listTokens(c: Context): Promise<Response> {
  const { user } = await requireSession(c);
  const { results } = await c.env.DB.prepare('SELECT id, name, created_at, last_used_at FROM cli_tokens WHERE user_id = ? ORDER BY created_at DESC')
    .bind(user.id)
    .all<{ id: string; name: string; created_at: number; last_used_at: number | null }>();
  return ok({ tokens: results.map((row) => ({ id: row.id, name: row.name, createdAt: isoTime(row.created_at), lastUsedAt: isoTime(row.last_used_at) })) });
}

/** DELETE /api/account/tokens/<id> */
export async function revokeToken(c: Context, id: string): Promise<Response> {
  const { user } = await requireSession(c);
  const result = await c.env.DB.prepare('DELETE FROM cli_tokens WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  if (result.meta.changes !== 1) throw new HttpError(404, 'not_found', 'No such token.');
  return ok();
}

/** GET /api/account/shares */
export async function sharesOfAccount(c: Context): Promise<Response> {
  const { user } = await requireSession(c);
  return ok({ shares: await listShares(c.env, c.origin, user.id) });
}

/** DELETE /api/account/shares/<id> */
export async function deleteShareOfAccount(c: Context, id: string): Promise<Response> {
  const { user } = await requireSession(c);
  if (!(await deleteShares(c.env, user.id, [id]))) throw new HttpError(404, 'not_found', 'No such share.');
  return ok();
}

/** Deletes an account: its shares in R2 first, then every row that belongs to it. Also used by the admin area. */
export async function deleteUserData(env: AccountEnv, userId: string): Promise<void> {
  const { results } = await env.DB.prepare('SELECT id FROM shares WHERE user_id = ?').bind(userId).all<{ id: string }>();
  await deleteShares(
    env,
    userId,
    results.map((row) => row.id),
  );
  await env.DB.batch(
    ['sessions', 'sign_in_challenges', 'email_tokens', 'email_changes', 'recovery_codes', 'passkeys', 'webauthn_challenges', 'cli_tokens', 'device_codes', 'shares']
      .map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId))
      .concat(env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId)),
  );
}

/** POST /api/account/delete, after a recent confirmation: deletes the shares in R2 and every row. */
export async function deleteAccount(c: Context): Promise<Response> {
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  await deleteUserData(c.env, user.id);
  c.cookies.push(clearCookie(SESSION_COOKIE));
  sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'account-deleted' });
  return ok();
}

