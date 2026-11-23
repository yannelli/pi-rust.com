// /api/admin/bug-reports: the /bug reports that pi-rust uploaded. The list comes from the bug_reports
// table; the files come from R2 (bug-reports/<id>/<part>), as the upload stored them.

import { isoTime } from '../accounts/context';
import { API_HEADERS, HttpError, ok, type Json } from '../accounts/http';
import { BUG_REPORT_PREFIX, FILE_TYPES } from '../bug-reports';
import { choiceOf, contains, count, logEvent, offsetOf, page, PAGE_SIZE, requireAdmin, requireAdminRecentAuth, searchOf, type AdminContext } from './common';

const STATUSES = ['open', 'closed', 'all'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** report.json and diagnostics.json are shown in the page up to this size; larger ones are downloads only. */
const INLINE_BYTES = 512 * 1024;

interface BugReportRow {
  id: string;
  received_at: number;
  description: string;
  version: string;
  platform: string;
  model: string;
  files: string;
  size: number;
  status: 'open' | 'closed';
  closed_at: number | null;
}

function files(row: BugReportRow): { name: string; size: number }[] {
  try {
    const value: unknown = JSON.parse(row.files);
    return Array.isArray(value) ? (value as { name: string; size: number }[]) : [];
  } catch {
    return [];
  }
}

function reportJson(row: BugReportRow) {
  return {
    id: row.id,
    receivedAt: isoTime(row.received_at),
    description: row.description,
    version: row.version,
    platform: row.platform,
    model: row.model,
    files: files(row),
    size: row.size,
    status: row.status,
    closedAt: isoTime(row.closed_at),
  };
}

/** GET /api/admin/bug-reports?q=&status=open|closed|all&offset=. `q` matches the description, version, platform, model, or ID. */
export async function listReports(c: AdminContext): Promise<Response> {
  await requireAdmin(c);
  const q = searchOf(c);
  const status = choiceOf(c, 'status', STATUSES);
  const offset = offsetOf(c);
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (status !== 'all') {
    conditions.push('status = ?');
    binds.push(status);
  }
  if (q) {
    conditions.push("(description LIKE ? ESCAPE '\\' OR version LIKE ? ESCAPE '\\' OR platform LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\' OR id = ?)");
    binds.push(contains(q), contains(q), contains(q), contains(q), q.toLowerCase());
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [{ results }, total] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM bug_reports ${where} ORDER BY received_at DESC, id LIMIT ? OFFSET ?`)
      .bind(...binds, PAGE_SIZE + 1, offset)
      .all<BugReportRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM bug_reports ${where}`)
      .bind(...binds)
      .first<{ n: number }>(),
  ]);
  const { rows, next } = page(results, offset);
  return ok({ reports: rows.map(reportJson), total: count(total?.n), next });
}

async function findReport(c: AdminContext, id: string): Promise<BugReportRow> {
  const row = UUID.test(id) ? await c.env.DB.prepare('SELECT * FROM bug_reports WHERE id = ?').bind(id).first<BugReportRow>() : null;
  if (!row) throw new HttpError(404, 'not_found', 'No such bug report.');
  return row;
}

/** A JSON part of the report, parsed, when it is in R2 and small enough to show. */
async function jsonPart(c: AdminContext, id: string, name: string): Promise<Json | null> {
  const object = await c.env.BUG_REPORTS.get(`${BUG_REPORT_PREFIX}${id}/${name}`);
  if (!object || object.size > INLINE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(await object.text());
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

/** GET /api/admin/bug-reports/<id>: the row, with report.json and diagnostics.json when they are small enough to show. */
export async function getReport(c: AdminContext, id: string): Promise<Response> {
  await requireAdmin(c);
  const row = await findReport(c, id);
  const [report, diagnostics] = await Promise.all([jsonPart(c, row.id, 'report.json'), jsonPart(c, row.id, 'diagnostics.json')]);
  return ok({ report: reportJson(row), reportJson: report, diagnostics });
}

/** GET /api/admin/bug-reports/<id>/files/<part>: the file as uploaded, as a download. */
export async function downloadFile(c: AdminContext, id: string, name: string): Promise<Response> {
  await requireAdmin(c);
  if (!(name in FILE_TYPES)) throw new HttpError(404, 'not_found', 'No such file.');
  const row = await findReport(c, id);
  const object = await c.env.BUG_REPORTS.get(`${BUG_REPORT_PREFIX}${row.id}/${name}`);
  if (!object) throw new HttpError(404, 'not_found', 'The file is no longer stored.');
  return new Response(object.body, {
    headers: {
      ...API_HEADERS,
      'Content-Type': FILE_TYPES[name],
      'Content-Disposition': `attachment; filename="bug-${row.id.slice(0, 8)}-${name}"`,
      'Content-Length': String(object.size),
    },
  });
}

/** PATCH /api/admin/bug-reports/<id> with {"status": "open" | "closed"}. */
export async function setReportStatus(c: AdminContext, id: string, body: Json): Promise<Response> {
  const admin = await requireAdmin(c);
  const status = body.status;
  if (status !== 'open' && status !== 'closed') throw new HttpError(400, 'invalid_request', 'status must be "open" or "closed".');
  const row = await findReport(c, id);
  if (row.status !== status) {
    await c.env.DB.prepare('UPDATE bug_reports SET status = ?, closed_at = ? WHERE id = ?')
      .bind(status, status === 'closed' ? Date.now() : null, row.id)
      .run();
    await logEvent(c, admin, status === 'closed' ? 'close-report' : 'reopen-report', { type: 'bug-report', id: row.id, label: label(row) });
  }
  return ok({ status });
}

/** DELETE /api/admin/bug-reports/<id>, after a recent confirmation: the files in R2, then the row. */
export async function deleteReport(c: AdminContext, id: string): Promise<Response> {
  const admin = await requireAdminRecentAuth(c);
  const row = await findReport(c, id);
  await c.env.BUG_REPORTS.delete(Object.keys(FILE_TYPES).map((name) => `${BUG_REPORT_PREFIX}${row.id}/${name}`));
  await c.env.DB.prepare('DELETE FROM bug_reports WHERE id = ?').bind(row.id).run();
  await logEvent(c, admin, 'delete-report', { type: 'bug-report', id: row.id, label: label(row) });
  return ok();
}

/** The first line of the description, or the ID. */
const label = (row: BugReportRow) => row.description.split('\n')[0].trim().slice(0, 120) || row.id;
