// /api/admin/users: list and search accounts, change a role, suspend and restore, sign out
// everywhere, and delete. An admin cannot act on their own account here, and an admin must be
// made a regular account before it can be suspended or deleted.

import { isoTime, userById, type User } from '../accounts/context';
import { sendEmail } from '../accounts/email';
import { HttpError, ok, type Json } from '../accounts/http';
import { deleteUserData } from '../accounts/security';
import {
  choiceOf,
  contains,
  count,
  logEvent,
  offsetOf,
  page,
  PAGE_SIZE,
  reason,
  requireAdmin,
  requireAdminRecentAuth,
  searchOf,
  type Admin,
  type AdminContext,
} from './common';

const FILTERS = ['all', 'admins', 'suspended', 'unverified'] as const;

const FILTER_SQL: Record<(typeof FILTERS)[number], string> = {
  all: '1 = 1',
  admins: "u.role = 'admin'",
  suspended: 'u.suspended_at IS NOT NULL',
  unverified: 'u.email_verified_at IS NULL',
};

interface UserListRow {
  id: string;
  email: string;
  email_verified_at: number | null;
  created_at: number;
  role: string;
  suspended_at: number | null;
  totp_enabled_at: number | null;
  passkeys: number;
  shares: number;
  tokens: number;
  last_seen_at: number | null;
  github_login: string | null;
}

function userJson(row: UserListRow, me: string) {
  return {
    id: row.id,
    email: row.email,
    verified: row.email_verified_at !== null,
    createdAt: isoTime(row.created_at),
    lastActiveAt: isoTime(row.last_seen_at || null),
    admin: row.role === 'admin',
    suspendedAt: isoTime(row.suspended_at),
    totp: row.totp_enabled_at !== null,
    passkeys: count(row.passkeys),
    shares: count(row.shares),
    cliTokens: count(row.tokens),
    github: row.github_login,
    you: row.id === me,
  };
}

/** GET /api/admin/users?q=&filter=all|admins|suspended|unverified&offset=. `q` matches the address or the GitHub username. */
export async function listUsers(c: AdminContext): Promise<Response> {
  const { user: me } = await requireAdmin(c);
  const q = searchOf(c);
  const filter = choiceOf(c, 'filter', FILTERS);
  const offset = offsetOf(c);
  const where = `${FILTER_SQL[filter]}${q ? " AND (u.email LIKE ? ESCAPE '\\' OR g.login LIKE ? ESCAPE '\\')" : ''}`;
  const binds = q ? [contains(q), contains(q)] : [];
  const [{ results }, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT u.id, u.email, u.email_verified_at, u.created_at, u.role, u.suspended_at, u.totp_enabled_at,
        (SELECT COUNT(*) FROM passkeys WHERE user_id = u.id) AS passkeys,
        (SELECT COUNT(*) FROM shares WHERE user_id = u.id) AS shares,
        (SELECT COUNT(*) FROM cli_tokens WHERE user_id = u.id) AS tokens,
        MAX(COALESCE((SELECT MAX(last_seen_at) FROM sessions WHERE user_id = u.id), 0),
            COALESCE((SELECT MAX(last_used_at) FROM cli_tokens WHERE user_id = u.id), 0)) AS last_seen_at,
        g.login AS github_login
       FROM users u LEFT JOIN github_accounts g ON g.user_id = u.id WHERE ${where} ORDER BY u.created_at DESC, u.id LIMIT ? OFFSET ?`,
    )
      .bind(...binds, PAGE_SIZE + 1, offset)
      .all<UserListRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users u LEFT JOIN github_accounts g ON g.user_id = u.id WHERE ${where}`)
      .bind(...binds)
      .first<{ n: number }>(),
  ]);
  const { rows, next } = page(results, offset);
  return ok({ users: rows.map((row) => userJson(row, me.id)), total: count(total?.n), next });
}

/** The account an admin acts on: not their own, and present. */
async function target(c: AdminContext, admin: Admin, id: string): Promise<User> {
  if (id === admin.user.id) throw new HttpError(409, 'own_account', 'Use your own account pages to change your account.');
  const user = await userById(c, id);
  if (!user) throw new HttpError(404, 'not_found', 'No such account.');
  return user;
}

function notAdmin(user: User): void {
  if (user.role === 'admin') throw new HttpError(409, 'is_admin', 'Remove admin access first.');
}

/** Ends every browser session, CLI token, and pending sign-in of an account. */
function signOutStatements(c: AdminContext, userId: string) {
  return ['sessions', 'cli_tokens', 'sign_in_challenges', 'webauthn_challenges', 'github_states', 'device_codes'].map((table) =>
    c.env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId),
  );
}

/** POST /api/admin/users/<id>/role with {"role": "admin" | "user"}, after a recent confirmation. */
export async function setRole(c: AdminContext, id: string, body: Json): Promise<Response> {
  const admin = await requireAdminRecentAuth(c);
  const role = body.role;
  if (role !== 'admin' && role !== 'user') throw new HttpError(400, 'invalid_request', 'role must be "admin" or "user".');
  const user = await target(c, admin, id);
  if (role === 'admin' && user.suspended_at) throw new HttpError(409, 'suspended', 'Restore the account first.');
  if (role === 'admin' && !user.email_verified_at) throw new HttpError(409, 'email_not_verified', 'The account must verify its email address first.');
  if (user.role !== role) {
    await c.env.DB.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').bind(role, Date.now(), user.id).run();
    await logEvent(c, admin, 'role', { type: 'account', id: user.id, label: user.email }, role);
  }
  return ok({ role });
}

/** POST /api/admin/users/<id>/suspend with an optional {"reason"}, after a recent confirmation. */
export async function suspend(c: AdminContext, id: string, body: Json): Promise<Response> {
  const admin = await requireAdminRecentAuth(c);
  const user = await target(c, admin, id);
  notAdmin(user);
  if (!user.suspended_at) {
    const now = Date.now();
    await c.env.DB.batch([c.env.DB.prepare('UPDATE users SET suspended_at = ?, updated_at = ? WHERE id = ?').bind(now, now, user.id), ...signOutStatements(c, user.id)]);
    await logEvent(c, admin, 'suspend', { type: 'account', id: user.id, label: user.email }, reason(body));
  }
  return ok();
}

/** POST /api/admin/users/<id>/restore, after a recent confirmation. */
export async function restore(c: AdminContext, id: string): Promise<Response> {
  const admin = await requireAdminRecentAuth(c);
  const user = await target(c, admin, id);
  if (user.suspended_at) {
    await c.env.DB.prepare('UPDATE users SET suspended_at = NULL, updated_at = ? WHERE id = ?').bind(Date.now(), user.id).run();
    await logEvent(c, admin, 'restore', { type: 'account', id: user.id, label: user.email });
  }
  return ok();
}

/** POST /api/admin/users/<id>/sign-out: ends every session and CLI token, after a recent confirmation. */
export async function signOutEverywhere(c: AdminContext, id: string): Promise<Response> {
  const admin = await requireAdminRecentAuth(c);
  const user = await target(c, admin, id);
  await c.env.DB.batch(signOutStatements(c, user.id));
  await logEvent(c, admin, 'sign-out', { type: 'account', id: user.id, label: user.email });
  return ok();
}

/** POST /api/admin/users/<id>/delete, after a recent confirmation. The account gets the usual deletion email. */
export async function deleteUser(c: AdminContext, id: string): Promise<Response> {
  const admin = await requireAdminRecentAuth(c);
  const user = await target(c, admin, id);
  notAdmin(user);
  await deleteUserData(c.env, user.id);
  await logEvent(c, admin, 'delete-account', { type: 'account', id: user.id, label: user.email });
  sendEmail(c.env, c.request, c.ctx, user.email, { kind: 'account-deleted' });
  return ok();
}
