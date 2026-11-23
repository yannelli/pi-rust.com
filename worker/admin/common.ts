// Pieces the admin handlers share: the admin check, the activity log, paging, and search.
// See docs/admin.md.

import type { BugReportEnv } from '../bug-reports';
import { passkeyCount } from '../accounts/common';
import type { Context, SessionRow, User } from '../accounts/context';
import { randomId } from '../accounts/crypto';
import type { AccountEnv } from '../accounts/env';
import { HttpError, type Json } from '../accounts/http';
import { requireRecentAuth, requireSession } from '../accounts/sessions';

export interface AdminEnv extends AccountEnv, Pick<BugReportEnv, 'BUG_REPORTS'> {
  /** The Cloudflare account that holds the install telemetry dataset. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** The pi-rust.com zone, whose request analytics give the versions in use. */
  CLOUDFLARE_ZONE_ID?: string;
  /**
   * Secret: an API token with Account Analytics Read (install stats) and Analytics Read on the
   * pi-rust.com zone (versions in use). Optional.
   */
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
}

export type AdminContext = Context & { env: AdminEnv };

export interface Admin {
  session: SessionRow;
  user: User;
}

/**
 * The signed-in admin. An admin needs two-step verification (TOTP or a passkey) on, so a stolen password
 * alone never opens the admin area.
 */
export async function requireAdmin(c: AdminContext): Promise<Admin> {
  const auth = await requireSession(c);
  if (auth.user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can do this.');
  if (!auth.user.totp_enabled_at && (await passkeyCount(c, auth.user.id)) === 0) {
    throw new HttpError(403, 'two_step_required', 'Turn on two-step verification or add a passkey to use the admin area.');
  }
  return auth;
}

/** An admin with a password or passkey confirmation from the last 10 minutes, for actions that are hard to undo. */
export async function requireAdminRecentAuth(c: AdminContext): Promise<Admin> {
  const admin = await requireAdmin(c);
  requireRecentAuth(admin.session);
  return admin;
}

export type EventAction =
  | 'role'
  | 'suspend'
  | 'restore'
  | 'sign-out'
  | 'delete-account'
  | 'hide-share'
  | 'delete-share'
  | 'close-report'
  | 'reopen-report'
  | 'delete-report';

export interface EventTarget {
  type: 'account' | 'share' | 'bug-report';
  id: string;
  label: string;
}

/** Records what an admin did. */
export async function logEvent(c: AdminContext, admin: Admin, action: EventAction, target: EventTarget, detail: string | null = null): Promise<void> {
  await c.env.DB.prepare(
    'INSERT INTO admin_events (id, admin_id, admin_email, action, target_type, target_id, target_label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(randomId(), admin.user.id, admin.user.email, action, target.type, target.id, target.label.slice(0, 300), detail, Date.now())
    .run();
}

export const DAY = 24 * 60 * 60 * 1000;
/** The overview's charts show this many days, today included. */
export const DAYS = 30;

/** UTC midnight `DAYS - 1` days ago: the first day of the charts. */
export const chartStart = (now: number) => Math.floor(now / DAY) * DAY - (DAYS - 1) * DAY;
export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Rows per page of every admin list. */
export const PAGE_SIZE = 50;

/** The `offset` query parameter: a whole number, at most 100,000. */
export function offsetOf(c: Context): number {
  const value = Number(c.url.searchParams.get('offset') ?? 0);
  return Number.isInteger(value) && value >= 0 && value <= 100_000 ? value : 0;
}

/** One page of rows: the query asks for PAGE_SIZE + 1, so an extra row means there is a next page. */
export function page<T>(rows: T[], offset: number): { rows: T[]; next: number | null } {
  return { rows: rows.slice(0, PAGE_SIZE), next: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null };
}

/** The `q` query parameter, trimmed, at most 200 characters. */
export const searchOf = (c: Context) => (c.url.searchParams.get('q') ?? '').trim().slice(0, 200);

/** A LIKE pattern that matches `text` anywhere; use it with ESCAPE '\'. */
export const contains = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/** One of `allowed`, from the query parameter `name`; the first when missing or unknown. */
export function choiceOf<T extends string>(c: Context, name: string, allowed: readonly T[]): T {
  const value = c.url.searchParams.get(name) as T | null;
  return value && allowed.includes(value) ? value : allowed[0];
}

export const count = (value: unknown) => Number(value ?? 0) || 0;

export function reason(body: Json): string | null {
  const value = typeof body.reason === 'string' ? body.reason.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 500) : '';
  return value || null;
}
