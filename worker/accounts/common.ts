// Pieces several account handlers share: secrets, password rules, email links, recovery codes,
// and the second-step state.

import type { Context, User } from './context';
import { hmacHex, randomId, randomToken, sha256 } from './crypto';
import { HttpError } from './http';
import { newRecoveryCode, normalizeRecoveryCode, RECOVERY_CODE_COUNT } from './totp';

export function pepper(c: Context): string {
  if (!c.env.AUTH_PEPPER) {
    console.error('AUTH_PEPPER is not set');
    throw new HttpError(503, 'not_configured', 'Accounts are not available right now.');
  }
  return c.env.AUTH_PEPPER;
}

export function totpKey(c: Context): string {
  if (!c.env.TOTP_ENCRYPTION_KEY) {
    console.error('TOTP_ENCRYPTION_KEY is not set');
    throw new HttpError(503, 'not_configured', 'Two-step verification is not available right now.');
  }
  return c.env.TOTP_ENCRYPTION_KEY;
}

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

/** Why a new password is not allowed, or undefined when it is. */
export function passwordProblem(password: string, email: string): string | undefined {
  const length = [...password].length;
  if (length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (password.trim().toLowerCase() === email.trim().toLowerCase()) return 'Don’t use your email address as your password.';
  return undefined;
}

export function checkNewPassword(password: string, email: string): void {
  const problem = passwordProblem(password, email);
  if (problem) throw new HttpError(400, 'invalid_password', problem, { field: 'password' });
}

export function requireVerified(user: User): void {
  if (!user.email_verified_at) throw new HttpError(403, 'email_not_verified', 'Verify your email address first.');
}

const HOUR = 60 * 60 * 1000;
const EMAIL_TOKEN_TTL = { verify: 24 * HOUR, reset: 30 * 60 * 1000 } as const;

/** A new single-use link for `purpose`. Earlier unused links for the same purpose stop working. */
export async function emailLink(c: Context, user: User, purpose: 'verify' | 'reset'): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM email_tokens WHERE user_id = ? AND (purpose = ? OR expires_at < ?)').bind(user.id, purpose, now),
    c.env.DB.prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      await sha256(token),
      user.id,
      purpose,
      user.email,
      now,
      now + EMAIL_TOKEN_TTL[purpose],
    ),
  ]);
  return `${c.origin}/account/${purpose === 'verify' ? 'verify' : 'new-password'}/#token=${token}`;
}

export interface EmailTokenRow {
  token_hash: string;
  user_id: string;
  email: string;
}

/** The unused, unexpired token row, without using it up. */
export async function findEmailToken(c: Context, token: string, purpose: 'verify' | 'reset'): Promise<EmailTokenRow> {
  const row =
    token && token.length <= 100
      ? await c.env.DB.prepare('SELECT token_hash, user_id, email FROM email_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?')
          .bind(await sha256(token), purpose, Date.now())
          .first<EmailTokenRow>()
      : null;
  if (!row) throw new HttpError(400, 'invalid_token', 'This link has expired or was already used.');
  return row;
}

/** Marks the token used. Fails when another request used it first. */
export async function useEmailToken(c: Context, row: EmailTokenRow): Promise<void> {
  const result = await c.env.DB.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(Date.now(), row.token_hash).run();
  if (result.meta.changes !== 1) throw new HttpError(400, 'invalid_token', 'This link has expired or was already used.');
}

export const resetLink = (c: Context) => `${c.origin}/account/reset/`;

async function recoveryHash(c: Context, code: string): Promise<string> {
  return hmacHex(pepper(c), `recovery:${normalizeRecoveryCode(code)}`);
}

/** Replaces the user's recovery codes with 10 new ones and returns them. They are shown once. */
export async function newRecoveryCodes(c: Context, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(userId),
    ...(await Promise.all(
      codes.map(async (code) =>
        c.env.DB.prepare('INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)').bind(randomId(), userId, await recoveryHash(c, code), now),
      ),
    )),
  ]);
  return codes;
}

/** Uses up a recovery code. True when it was valid and unused. */
export async function useRecoveryCode(c: Context, userId: string, code: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(code);
  if (!/^[a-z0-9]{10}$/.test(normalized)) return false;
  const result = await c.env.DB.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
    .bind(Date.now(), userId, await recoveryHash(c, normalized))
    .run();
  return result.meta.changes === 1;
}

export async function recoveryCodesLeft(c: Context, userId: string): Promise<number> {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function passkeyCount(c: Context, userId: string): Promise<number> {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Recovery codes back up a second step. With no TOTP and no passkey left, they are removed. */
export async function dropRecoveryCodesIfUnused(c: Context, userId: string): Promise<void> {
  const user = await c.env.DB.prepare('SELECT totp_enabled_at FROM users WHERE id = ?').bind(userId).first<{ totp_enabled_at: number | null }>();
  if (!user?.totp_enabled_at && (await passkeyCount(c, userId)) === 0) {
    await c.env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(userId).run();
  }
}
