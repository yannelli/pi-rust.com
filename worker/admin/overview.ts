// /api/admin/overview, /api/admin/installs, and /api/admin/activity: the numbers on the admin home page,
// install pings from Analytics Engine, and the log of what admins did.

import { isoTime } from '../accounts/context';
import { ok } from '../accounts/http';
import { INSTALL_TELEMETRY_DATASET } from '../install-telemetry';
import { chartStart, count, DAY, DAYS, dayKey, offsetOf, page, PAGE_SIZE, requireAdmin, type AdminContext } from './common';

/** Counts per UTC day for the last 30 days, from `SELECT day, n` rows where `day` is whole days since the chart start. A bound number can arrive as REAL, so the query casts. */
function perDay(rows: { day: number; n: number }[]): number[] {
  const out = Array.from({ length: DAYS }, () => 0);
  for (const row of rows) if (row.day >= 0 && row.day < DAYS) out[row.day] = count(row.n);
  return out;
}

/** GET /api/admin/overview */
export async function overview(c: AdminContext): Promise<Response> {
  await requireAdmin(c);
  const now = Date.now();
  const week = now - 7 * DAY;
  const start = chartStart(now);
  const db = c.env.DB;
  const [users, shares, tokens, reports, signUps, newShares] = await db.batch([
    db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(email_verified_at IS NOT NULL) AS verified, SUM(role = 'admin') AS admins,
          SUM(suspended_at IS NOT NULL) AS suspended,
          SUM(totp_enabled_at IS NOT NULL OR EXISTS (SELECT 1 FROM passkeys WHERE passkeys.user_id = users.id)) AS two_step,
          SUM(created_at >= ?) AS new_week
         FROM users`,
      )
      .bind(week),
    db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(visibility = 'link') AS link, SUM(visibility = 'private') AS private,
          SUM(expires_at IS NOT NULL AND expires_at > ?) AS expiring, SUM(expires_at IS NOT NULL AND expires_at <= ?) AS expired,
          SUM(size) AS bytes, SUM(view_count) AS views, SUM(created_at >= ?) AS new_week
         FROM shares`,
      )
      .bind(now, now, week),
    db.prepare('SELECT COUNT(*) AS total FROM cli_tokens'),
    db.prepare("SELECT COUNT(*) AS total, SUM(status = 'open') AS open, SUM(received_at >= ?) AS new_week FROM bug_reports").bind(week),
    db.prepare('SELECT CAST((created_at - ?) / 86400000 AS INTEGER) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day').bind(start, start),
    db.prepare('SELECT CAST((created_at - ?) / 86400000 AS INTEGER) AS day, COUNT(*) AS n FROM shares WHERE created_at >= ? GROUP BY day').bind(start, start),
  ]);
  const one = (result: { results: unknown[] }) => (result.results[0] ?? {}) as Record<string, number | null>;
  const u = one(users);
  const s = one(shares);
  const r = one(reports);
  const signUpDays = perDay(signUps.results as { day: number; n: number }[]);
  const shareDays = perDay(newShares.results as { day: number; n: number }[]);
  return ok({
    accounts: {
      total: count(u.total),
      verified: count(u.verified),
      admins: count(u.admins),
      suspended: count(u.suspended),
      twoStep: count(u.two_step),
      newThisWeek: count(u.new_week),
    },
    shares: {
      total: count(s.total),
      link: count(s.link),
      private: count(s.private),
      expiring: count(s.expiring),
      expired: count(s.expired),
      bytes: count(s.bytes),
      views: count(s.views),
      newThisWeek: count(s.new_week),
    },
    cliTokens: count(one(tokens).total),
    bugReports: { total: count(r.total), open: count(r.open), newThisWeek: count(r.new_week) },
    days: signUpDays.map((signUps, index) => ({ date: dayKey(start + index * DAY), signUps, shares: shareDays[index] })),
  });
}

interface SqlResult {
  data?: Record<string, string | number>[];
}

/** GET /api/admin/installs: install and update pings of the last 30 days, through the Analytics Engine SQL API. */
export async function installs(c: AdminContext): Promise<Response> {
  await requireAdmin(c);
  const account = c.env.CLOUDFLARE_ACCOUNT_ID;
  const token = c.env.CLOUDFLARE_ANALYTICS_TOKEN;
  if (!account || !token) return ok({ configured: false });
  const range = `FROM ${INSTALL_TELEMETRY_DATASET} WHERE timestamp > NOW() - INTERVAL '${DAYS}' DAY`;
  const sql = async (query: string) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: `${query} FORMAT JSON`,
    });
    if (!response.ok) throw new Error(`The Cloudflare SQL API answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return ((await response.json()) as SqlResult).data ?? [];
  };
  try {
    // SUM(_sample_interval), not COUNT(), because Analytics Engine can sample a busy dataset.
    const [versions, platforms, days] = await Promise.all([
      sql(`SELECT blob1 AS version, SUM(_sample_interval) AS pings ${range} GROUP BY version ORDER BY pings DESC LIMIT 10`),
      sql(`SELECT blob2 AS platform, blob3 AS arch, SUM(_sample_interval) AS pings ${range} GROUP BY platform, arch ORDER BY pings DESC LIMIT 10`),
      sql(`SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, SUM(_sample_interval) AS pings ${range} GROUP BY day ORDER BY day LIMIT 40`),
    ]);
    const byDay = new Map(days.map((row) => [String(row.day).slice(0, 10), count(row.pings)]));
    const start = chartStart(Date.now());
    return ok({
      configured: true,
      total: [...byDay.values()].reduce((sum, n) => sum + n, 0),
      versions: versions.map((row) => ({ version: String(row.version), pings: count(row.pings) })),
      platforms: platforms.map((row) => ({ platform: String(row.platform), arch: String(row.arch), pings: count(row.pings) })),
      days: Array.from({ length: DAYS }, (_, index) => {
        const date = dayKey(start + index * DAY);
        return { date, pings: byDay.get(date) ?? 0 };
      }),
    });
  } catch (error) {
    console.error('install stats failed', (error as Error)?.message);
    return ok({ configured: true, error: 'Could not read install stats from Cloudflare. The Worker log has the details.' });
  }
}

interface EventRow {
  id: string;
  admin_email: string;
  action: string;
  target_type: string;
  target_id: string;
  target_label: string;
  detail: string | null;
  created_at: number;
}

/** GET /api/admin/activity?offset=: what admins did, newest first. */
export async function activity(c: AdminContext): Promise<Response> {
  await requireAdmin(c);
  const offset = offsetOf(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM admin_events ORDER BY created_at DESC, id LIMIT ? OFFSET ?')
    .bind(PAGE_SIZE + 1, offset)
    .all<EventRow>();
  const { rows, next } = page(results, offset);
  return ok({
    events: rows.map((row) => ({
      id: row.id,
      admin: row.admin_email,
      action: row.action,
      target: { type: row.target_type, id: row.target_id, label: row.target_label },
      detail: row.detail,
      createdAt: isoTime(row.created_at),
    })),
    next,
  });
}
