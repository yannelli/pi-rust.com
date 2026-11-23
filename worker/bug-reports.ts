// POST /v1/bug-reports: pi-rust `/bug` reports, in the multipart contract of upstream pi's Radius
// gateway. The files go to R2 and to the maintainer by email, and a row in D1 lists the report in the
// admin area (docs/admin.md).

import type { D1Database } from './accounts/env';
import { PRODUCTION_ORIGIN } from './accounts/http';

export interface R2Object {
  key: string;
  size: number;
  uploaded: Date;
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  text(): Promise<string>;
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix?: string; cursor?: string; limit?: number; include?: ('customMetadata' | 'httpMetadata')[] }): Promise<{
    objects: R2Object[];
    truncated: boolean;
    cursor?: string;
  }>;
}

interface EmailAttachment {
  content: ArrayBuffer | ArrayBufferView;
  filename: string;
  type: string;
  disposition: 'attachment';
}

export interface SendEmail {
  send(message: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
    attachments?: EmailAttachment[];
  }): Promise<{ messageId: string }>;
}

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface BugReportEnv {
  BUG_REPORTS: R2Bucket;
  BUG_EMAIL: SendEmail;
  BUG_REPORT_LIMITER: RateLimit;
  BUG_REPORT_FROM: string;
  /** A Worker secret, so the address stays out of the repository. */
  BUG_REPORT_TO?: string;
  /** The bug_reports table lists reports in the admin area. */
  DB: D1Database;
}

export const BUG_REPORT_BUCKET = 'pi-rust-bug-reports';
export const BUG_REPORT_PREFIX = 'bug-reports/';
/** The bucket's lifecycle rule deletes the files after 90 days; the hourly cleanup deletes the rows then too. */
export const BUG_REPORT_DAYS = 90;

export const FILE_TYPES: Record<string, string> = {
  'report.json': 'application/json',
  'diagnostics.json': 'application/json',
  'session.jsonl': 'application/x-ndjson',
  'summary.md': 'text/markdown',
};

const MAX_REPORT_BYTES = 20 * 1024 * 1024;
/** Base64 adds a third, and Email Service caps a message at 25 MiB. */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Json = Record<string, unknown>;

function reply(status: number, body: Json, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function fail(status: number, error: string, description: string, headers?: Record<string, string>): Response {
  return reply(status, { ok: false, error, description }, headers);
}

function parseObject(text: string | undefined): Json | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

export async function handleBugReport(request: Request, env: BugReportEnv): Promise<Response> {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST', { Allow: 'POST' });
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
    return fail(415, 'unsupported_media_type', 'Send the report as multipart/form-data');
  }
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_REPORT_BYTES) return fail(413, 'too_large', 'Report too large');
  const { success } = await env.BUG_REPORT_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
  if (!success) return fail(429, 'rate_limited', 'Too many bug reports. Try again in a minute.');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, 'invalid_form', 'The report is not valid multipart form data');
  }
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const [name, value] of form.entries()) {
    if (!(name in FILE_TYPES) || files.has(name)) return fail(400, 'invalid_form', `Unexpected form field: ${name}`);
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(await value.arrayBuffer());
    total += bytes.byteLength;
    if (total > MAX_REPORT_BYTES) return fail(413, 'too_large', 'Report too large');
    files.set(name, bytes);
  }
  const text = (name: string) => (files.has(name) ? new TextDecoder().decode(files.get(name)) : undefined);
  const report = parseObject(text('report.json'));
  const diagnostics = parseObject(text('diagnostics.json'));
  if (!report || !diagnostics) {
    return fail(400, 'invalid_report', 'report.json and diagnostics.json must be JSON objects');
  }

  const id = await reportId(report, env);
  const prefix = `bug-reports/${id}/`;
  const receivedAt = new Date().toISOString();
  await Promise.all(
    [...files].map(([name, bytes]) =>
      env.BUG_REPORTS.put(prefix + name, bytes, {
        httpMetadata: { contentType: FILE_TYPES[name] },
        customMetadata: { receivedAt },
      }),
    ),
  );
  // The files are stored, so a failed row only delays the listing: the hourly cleanup adds missing rows.
  try {
    const sizes = [...files].map(([name, bytes]) => ({ name, size: bytes.byteLength }));
    await insertReportRow(env.DB, id, Date.parse(receivedAt), report, sizes);
  } catch (error) {
    console.error('bug report index failed', id, (error as Error)?.message);
  }
  try {
    await notify(env, id, report, diagnostics, files);
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: string; message?: string };
    console.error('bug report email failed', id, code, message);
  }
  return reply(201, { ok: true, bug_report: { id } });
}

/** The client's report ID when it is a new UUID, so the user's session and the email agree. */
async function reportId(report: Json, env: BugReportEnv): Promise<string> {
  const id = typeof report.id === 'string' ? report.id.toLowerCase() : '';
  if (UUID.test(id) && !(await env.BUG_REPORTS.head(`bug-reports/${id}/report.json`))) return id;
  return crypto.randomUUID();
}

function field(value: unknown, ...path: string[]): string {
  let current = value;
  for (const key of path) current = current && typeof current === 'object' ? (current as Json)[key] : undefined;
  return typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean' ? String(current) : '';
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

const oneLine = (value: string, max: number) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** Adds the D1 row that lists a report in the admin area. Does nothing when it exists. */
async function insertReportRow(db: D1Database, id: string, receivedAt: number, report: Json, files: { name: string; size: number }[]): Promise<boolean> {
  const provider = field(report, 'model', 'provider');
  const platform = ['platform', 'arch', 'osRelease'].map((key) => field(report, 'environment', key)).filter(Boolean).join(' ');
  const ordered = Object.keys(FILE_TYPES).flatMap((name) => files.filter((file) => file.name === name));
  const result = await db
    .prepare('INSERT OR IGNORE INTO bug_reports (id, received_at, description, version, platform, model, files, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(
      id,
      receivedAt,
      field(report, 'hint').trim().slice(0, 4000),
      oneLine(field(report, 'environment', 'version'), 64),
      oneLine(platform, 128),
      provider ? oneLine(`${provider}/${field(report, 'model', 'id')}`, 128) : '',
      JSON.stringify(ordered),
      ordered.reduce((sum, file) => sum + file.size, 0),
    )
    .run();
  return result.meta.changes === 1;
}

/** Reports read per cleanup run when their rows are missing; the next run takes the rest. */
const INDEX_BATCH = 50;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Adds a row for each report in R2 that has none: one whose row failed to write, or that arrived before
 * the bug_reports table existed. Run by the hourly cleanup. Returns how many rows it added.
 */
export async function indexMissingReports(env: Pick<BugReportEnv, 'BUG_REPORTS' | 'DB'>, now = Date.now()): Promise<number> {
  const reports = new Map<string, { files: { name: string; size: number }[]; receivedAt: number }>();
  let cursor: string | undefined;
  // At most 10,000 objects, about 2,500 reports: far more than 90 days of /bug reports.
  for (let page = 0; page < 10; page++) {
    const listing = await env.BUG_REPORTS.list({ prefix: BUG_REPORT_PREFIX, cursor, include: ['customMetadata'] });
    for (const object of listing.objects) {
      const [id, name] = object.key.slice(BUG_REPORT_PREFIX.length).split('/');
      if (!UUID.test(id ?? '') || !name || !(name in FILE_TYPES)) continue;
      const received = Date.parse(object.customMetadata?.receivedAt ?? '') || new Date(object.uploaded).getTime();
      const entry = reports.get(id) ?? { files: [], receivedAt: received };
      entry.files.push({ name, size: object.size });
      entry.receivedAt = Math.min(entry.receivedAt, received);
      reports.set(id, entry);
    }
    if (!listing.truncated || !listing.cursor) break;
    cursor = listing.cursor;
  }
  const { results } = await env.DB.prepare('SELECT id FROM bug_reports').all<{ id: string }>();
  const known = new Set(results.map((row) => row.id));
  const oldest = now - BUG_REPORT_DAYS * DAY;
  const missing = [...reports].filter(([id, entry]) => !known.has(id) && entry.receivedAt >= oldest && entry.files.some((file) => file.name === 'report.json'));
  let added = 0;
  for (const [id, entry] of missing.slice(0, INDEX_BATCH)) {
    const object = await env.BUG_REPORTS.get(`${BUG_REPORT_PREFIX}${id}/report.json`);
    const report = parseObject(object ? await object.text() : undefined) ?? {};
    if (await insertReportRow(env.DB, id, entry.receivedAt, report, entry.files)) added++;
  }
  return added;
}

function emailText(id: string, report: Json, diagnostics: Json, files: Map<string, Uint8Array>, attached: Set<string>): string {
  const hint = field(report, 'hint');
  const provider = field(report, 'model', 'provider');
  const model = provider ? `${provider}/${field(report, 'model', 'id')}` : 'none';
  const platform = ['platform', 'arch', 'osRelease'].map((key) => field(report, 'environment', key)).filter(Boolean);
  const listed = [...files].map(([name, bytes]) => `- ${name} (${bytes.byteLength} bytes, ${attached.has(name) ? 'attached' : 'in R2 only'})`);
  return [
    hint || '(no description)',
    '',
    `Report ID: ${id}`,
    `Version: ${field(report, 'environment', 'version')}`,
    `Platform: ${platform.join(' ')}`,
    `Model: ${model} (thinking ${field(report, 'thinkingLevel') || 'unknown'})`,
    `Transcript: ${field(report, 'session', 'included') === 'true' ? 'included' : 'not included'}`,
    `Summary: ${field(report, 'session', 'summaryIncluded') === 'true' ? 'included' : 'none'}`,
    `Failed turns: ${count(diagnostics.assistant)}, crashes: ${count(diagnostics.crashes)}`,
    `Extensions: ${count(report.extensions)}, extension errors: ${count(report.extensionErrors)}`,
    '',
    'Files:',
    ...listed,
    '',
    `Admin: ${PRODUCTION_ORIGIN}/admin/bug-reports/#${id}`,
    `R2: ${BUG_REPORT_BUCKET}/bug-reports/${id}/`,
    `npx wrangler r2 object get "${BUG_REPORT_BUCKET}/bug-reports/${id}/session.jsonl" --remote --file session.jsonl`,
    '',
  ].join('\n');
}

async function notify(env: BugReportEnv, id: string, report: Json, diagnostics: Json, files: Map<string, Uint8Array>): Promise<void> {
  if (!env.BUG_REPORT_TO) {
    console.warn('BUG_REPORT_TO is not set; bug report stored without email', id);
    return;
  }
  const attachments: EmailAttachment[] = [];
  const attached = new Set<string>();
  let size = 0;
  for (const [name, bytes] of files) {
    if (size + bytes.byteLength > MAX_ATTACHMENT_BYTES) continue;
    size += bytes.byteLength;
    attached.add(name);
    attachments.push({ content: bytes, filename: name, type: FILE_TYPES[name], disposition: 'attachment' });
  }
  const title = field(report, 'hint').split('\n')[0].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100);
  await env.BUG_EMAIL.send({
    to: env.BUG_REPORT_TO,
    from: { email: env.BUG_REPORT_FROM, name: 'pi-rust bug reports' },
    subject: `[pi-rust bug] ${title || id}`,
    text: emailText(id, report, diagnostics, files, attached),
    attachments,
  });
}
