// /api/admin/shares: every account's shares, with their owner. An admin can make a share private
// (only its owner can open it) or delete it. Admins see a private share's details, never its content.

import { isoTime } from '../accounts/context';
import { HttpError, ok } from '../accounts/http';
import { deleteShares, SHARE_ID, type ShareRow } from '../share/store';
import { choiceOf, contains, count, logEvent, offsetOf, page, PAGE_SIZE, requireAdmin, requireAdminRecentAuth, searchOf, type AdminContext } from './common';

const FILTERS = ['all', 'link', 'private', 'expired'] as const;

interface AdminShareRow extends ShareRow {
  owner_email: string;
  owner_suspended_at: number | null;
}

function shareJson(origin: string, row: AdminShareRow, now: number) {
  const expired = row.expires_at !== null && row.expires_at <= now;
  return {
    id: row.id,
    title: row.title,
    size: row.size,
    createdAt: isoTime(row.created_at),
    expiresAt: isoTime(row.expires_at),
    expired,
    visibility: row.visibility,
    views: row.view_count,
    lastViewedAt: isoTime(row.last_viewed_at),
    // Only a live share that anyone with the link can open gets a link here.
    url: row.visibility === 'link' && !expired && !row.owner_suspended_at ? `${origin}/s/${row.id}` : null,
    owner: { id: row.user_id, email: row.owner_email, suspended: row.owner_suspended_at !== null },
  };
}

/** GET /api/admin/shares?q=&filter=all|link|private|expired&offset=. `q` matches a title, an owner's email, or a share ID. */
export async function listShares(c: AdminContext): Promise<Response> {
  await requireAdmin(c);
  const q = searchOf(c);
  const filter = choiceOf(c, 'filter', FILTERS);
  const offset = offsetOf(c);
  const now = Date.now();
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (filter === 'link') {
    conditions.push("s.visibility = 'link' AND (s.expires_at IS NULL OR s.expires_at > ?)");
    binds.push(now);
  } else if (filter === 'private') {
    conditions.push("s.visibility = 'private'");
  } else if (filter === 'expired') {
    conditions.push('s.expires_at <= ?');
    binds.push(now);
  }
  if (q) {
    conditions.push("(s.title LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR s.id = ?)");
    binds.push(contains(q), contains(q), q);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const from = 'FROM shares s JOIN users u ON u.id = s.user_id';
  const [{ results }, total] = await Promise.all([
    c.env.DB.prepare(`SELECT s.*, u.email AS owner_email, u.suspended_at AS owner_suspended_at ${from} ${where} ORDER BY s.created_at DESC, s.id LIMIT ? OFFSET ?`)
      .bind(...binds, PAGE_SIZE + 1, offset)
      .all<AdminShareRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n ${from} ${where}`)
      .bind(...binds)
      .first<{ n: number }>(),
  ]);
  const { rows, next } = page(results, offset);
  return ok({ shares: rows.map((row) => shareJson(c.origin, row, now)), total: count(total?.n), next });
}

async function findShare(c: AdminContext, id: string): Promise<ShareRow> {
  const row = SHARE_ID.test(id) ? await c.env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(id).first<ShareRow>() : null;
  if (!row) throw new HttpError(404, 'not_found', 'No such share.');
  return row;
}

/** POST /api/admin/shares/<id>/hide: only the owner can open it from now on. The owner can share it again. */
export async function hideShare(c: AdminContext, id: string): Promise<Response> {
  const admin = await requireAdmin(c);
  const row = await findShare(c, id);
  if (row.visibility !== 'private') {
    await c.env.DB.prepare("UPDATE shares SET visibility = 'private' WHERE id = ?").bind(row.id).run();
    await logEvent(c, admin, 'hide-share', { type: 'share', id: row.id, label: row.title });
  }
  return ok();
}

/** DELETE /api/admin/shares/<id>, after a recent confirmation: the HTML in R2, then the row. */
export async function deleteShare(c: AdminContext, id: string): Promise<Response> {
  const admin = await requireAdminRecentAuth(c);
  const row = await findShare(c, id);
  await deleteShares(c.env, row.user_id, [row.id]);
  await logEvent(c, admin, 'delete-share', { type: 'share', id: row.id, label: row.title });
  return ok();
}
