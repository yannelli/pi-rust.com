// Share records: a D1 row per share and its HTML in R2 at shares/<id>.html. Also the rules for the
// settings a share can have (title, expiry, visibility), which the CLI API and the Shares page share.

import type { AccountEnv } from '../accounts/env';

export type Visibility = 'link' | 'private';

export interface ShareRow {
  id: string;
  user_id: string;
  title: string;
  size: number;
  created_at: number;
  /** Unix ms, or null for never. */
  expires_at: number | null;
  visibility: Visibility;
  view_count: number;
  last_viewed_at: number | null;
}

export interface Share {
  id: string;
  url: string;
  title: string;
  size: number;
  createdAt: string;
  expiresAt: string | null;
  visibility: Visibility;
  views: number;
  lastViewedAt: string | null;
}

export const shareKey = (id: string) => `shares/${id}.html`;

/** 128 random bits, base64url: 22 characters. */
export const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;

const MAX_TITLE = 200;
const DEFAULT_TITLE = 'Pi session';
/** expires_in and expiresIn: 1 hour to 365 days, in seconds. */
export const MIN_EXPIRES_IN = 60 * 60;
export const MAX_EXPIRES_IN = 365 * 24 * 60 * 60;
const VISIBILITIES: readonly Visibility[] = ['link', 'private'];

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function shareJson(origin: string, row: ShareRow): Share {
  return {
    id: row.id,
    url: `${origin}/s/${row.id}`,
    title: row.title,
    size: row.size,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: iso(row.expires_at),
    visibility: row.visibility,
    views: row.view_count,
    lastViewedAt: iso(row.last_viewed_at),
  };
}

export const isExpired = (row: Pick<ShareRow, 'expires_at'>, now = Date.now()) => row.expires_at !== null && row.expires_at <= now;

/** A title without control characters, at most 200 characters; "Pi session" when empty. */
export function shareTitle(raw: string | null | undefined): string {
  const clean = [...(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, MAX_TITLE).join('');
  return clean || DEFAULT_TITLE;
}

/** A bad setting. The CLI API and the account API both answer it with 400 invalid_request. */
export class InvalidShareSetting extends Error {}

const EXPIRES_IN_RULE = `from ${MIN_EXPIRES_IN} (1 hour) to ${MAX_EXPIRES_IN} (365 days)`;

/** Seconds until expiry: `expires_in` from the query (digits only) or `expiresIn` from JSON (a number). */
export function expiresInSeconds(value: unknown, name: string): number {
  const seconds = typeof value === 'string' ? (/^\d{1,12}$/.test(value) ? Number(value) : NaN) : value;
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < MIN_EXPIRES_IN || seconds > MAX_EXPIRES_IN) {
    throw new InvalidShareSetting(`${name} must be a whole number of seconds ${EXPIRES_IN_RULE}.`);
  }
  return seconds;
}

export function shareVisibility(value: unknown): Visibility {
  if (!VISIBILITIES.includes(value as Visibility)) throw new InvalidShareSetting('visibility must be "link" or "private".');
  return value as Visibility;
}

/** A share whose owner is not suspended. A suspended account's shares answer as if they did not exist. */
export async function getShare(env: AccountEnv, id: string): Promise<ShareRow | null> {
  if (!SHARE_ID.test(id)) return null;
  return env.DB.prepare('SELECT shares.* FROM shares JOIN users ON users.id = shares.user_id WHERE shares.id = ? AND users.suspended_at IS NULL')
    .bind(id)
    .first<ShareRow>();
}

export async function listShares(env: AccountEnv, origin: string, userId: string): Promise<Share[]> {
  const { results } = await env.DB.prepare('SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all<ShareRow>();
  return results.map((row) => shareJson(origin, row));
}

/**
 * Changes a share's title, expiry, or visibility: `{"title"?, "expiresIn"?: seconds | null, "visibility"?}`.
 * `expiresIn: null` removes the expiry. Returns the row, or null when the user has no such share.
 * Throws InvalidShareSetting for a bad value, before anything is written.
 */
export async function updateShare(env: AccountEnv, userId: string, id: string, body: Record<string, unknown>, now = Date.now()): Promise<ShareRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') throw new InvalidShareSetting('title must be a string.');
    sets.push('title = ?');
    values.push(shareTitle(body.title));
  }
  if (body.expiresIn !== undefined) {
    // JSON must send a number; a string such as "3600" is not one.
    const seconds = body.expiresIn === null ? null : expiresInSeconds(typeof body.expiresIn === 'string' ? NaN : body.expiresIn, 'expiresIn');
    sets.push('expires_at = ?');
    values.push(seconds === null ? null : now + seconds * 1000);
  }
  if (body.visibility !== undefined) {
    sets.push('visibility = ?');
    values.push(shareVisibility(body.visibility));
  }
  if (!SHARE_ID.test(id)) return null;
  if (!sets.length) return env.DB.prepare('SELECT * FROM shares WHERE id = ? AND user_id = ?').bind(id, userId).first<ShareRow>();
  return env.DB.prepare(`UPDATE shares SET ${sets.join(', ')} WHERE id = ? AND user_id = ? RETURNING *`)
    .bind(...values, id, userId)
    .first<ShareRow>();
}

/** Deletes the user's shares with these IDs from R2 and D1. Returns how many rows were deleted. */
export async function deleteShares(env: AccountEnv, userId: string, ids: string[]): Promise<number> {
  let deleted = 0;
  // D1 binds at most 100 values per statement.
  for (let i = 0; i < ids.length; i += 90) {
    const batch = ids.slice(i, i + 90).filter((id) => SHARE_ID.test(id));
    if (!batch.length) continue;
    const placeholders = batch.map(() => '?').join(', ');
    const { results } = await env.DB.prepare(`SELECT id FROM shares WHERE user_id = ? AND id IN (${placeholders})`)
      .bind(userId, ...batch)
      .all<{ id: string }>();
    if (!results.length) continue;
    const owned = results.map((row) => row.id);
    await env.SHARES.delete(owned.map(shareKey));
    const result = await env.DB.prepare(`DELETE FROM shares WHERE user_id = ? AND id IN (${owned.map(() => '?').join(', ')})`)
      .bind(userId, ...owned)
      .run();
    deleted += result.meta.changes;
  }
  return deleted;
}

/**
 * Deletes shares that expired by `now`: these IDs, or without IDs up to `limit` of them (of one user with
 * `userId`). The R2 objects go first, so a failure leaves a row that the next run retries, never an
 * object without a row. Returns how many rows were deleted.
 */
export async function deleteExpiredShares(env: AccountEnv, options: { now?: number; ids?: string[]; userId?: string; limit?: number } = {}): Promise<number> {
  const now = options.now ?? Date.now();
  let ids = options.ids?.filter((id) => SHARE_ID.test(id));
  if (!ids) {
    const owner = options.userId ? ' AND user_id = ?' : '';
    const binds: unknown[] = options.userId ? [now, options.userId] : [now];
    const { results } = await env.DB.prepare(`SELECT id FROM shares WHERE expires_at <= ?${owner} ORDER BY expires_at LIMIT ?`)
      .bind(...binds, options.limit ?? 500)
      .all<{ id: string }>();
    ids = results.map((row) => row.id);
  }
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 90) {
    const batch = ids.slice(i, i + 90);
    await env.SHARES.delete(batch.map(shareKey));
    const result = await env.DB.prepare(`DELETE FROM shares WHERE expires_at <= ? AND id IN (${batch.map(() => '?').join(', ')})`)
      .bind(now, ...batch)
      .run();
    deleted += result.meta.changes;
  }
  return deleted;
}
