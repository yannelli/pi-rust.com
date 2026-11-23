// The Shares page's API under /api/account/shares (session cookie, same CSRF rules as the rest of the
// account API). Listing and deleting one share are in accounts/security.ts.

import type { Context } from '../accounts/context';
import { HttpError, ok, type Json } from '../accounts/http';
import { requireRecentAuth, requireSession } from '../accounts/sessions';
import { deleteExpiredShares, deleteShares, InvalidShareSetting, shareJson, updateShare } from './store';

/** PATCH /api/account/shares/<id> with `{"title"?, "expiresIn"?: seconds | null, "visibility"?}`. */
export async function updateShareOfAccount(c: Context, id: string, body: Json): Promise<Response> {
  const { user } = await requireSession(c);
  let row;
  try {
    row = await updateShare(c.env, user.id, id, body);
  } catch (error) {
    if (error instanceof InvalidShareSetting) throw new HttpError(400, 'invalid_request', error.message);
    throw error;
  }
  if (!row) throw new HttpError(404, 'not_found', 'No such share.');
  return ok({ share: shareJson(c.origin, row) });
}

/** POST /api/account/shares/delete-expired: up to 1,000 at a time; the hourly cleanup takes the rest. */
export async function deleteExpiredSharesOfAccount(c: Context): Promise<Response> {
  const { user } = await requireSession(c);
  return ok({ deleted: await deleteExpiredShares(c.env, { userId: user.id, limit: 1000 }) });
}

/** POST /api/account/shares/delete-all, after a recent confirmation. */
export async function deleteAllSharesOfAccount(c: Context): Promise<Response> {
  const { session, user } = await requireSession(c);
  requireRecentAuth(session);
  const { results } = await c.env.DB.prepare('SELECT id FROM shares WHERE user_id = ?').bind(user.id).all<{ id: string }>();
  const deleted = await deleteShares(
    c.env,
    user.id,
    results.map((row) => row.id),
  );
  return ok({ deleted });
}
