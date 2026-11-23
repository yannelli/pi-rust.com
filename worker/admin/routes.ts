// Routes for /api/admin/*. Every request needs a signed-in admin with two-step verification on, and every
// state-changing request must be JSON from the site origin, as in the account API. See docs/admin.md.

import { context, withCookies } from '../accounts/context';
import type { ExecutionContext } from '../accounts/env';
import { checkSameOrigin, fail, HttpError, readJson, type Json } from '../accounts/http';
import * as reports from './bug-reports';
import type { AdminContext, AdminEnv } from './common';
import { activity, installs, overview } from './overview';
import * as people from './people';
import * as shares from './shares';
import { versions } from './versions';

type Handler = (c: AdminContext, body: Json, params: string[]) => Promise<Response>;

const ID = '([A-Za-z0-9_-]{1,64})';
const FILE = '(report\\.json|diagnostics\\.json|session\\.jsonl|summary\\.md)';
const route = (path: string) => new RegExp(`^${path}$`);

const ROUTES: [method: string, path: RegExp, handler: Handler][] = [
  ['GET', route('overview'), (c) => overview(c)],
  ['GET', route('installs'), (c) => installs(c)],
  ['GET', route('versions'), (c) => versions(c)],
  ['GET', route('activity'), (c) => activity(c)],
  ['GET', route('users'), (c) => people.listUsers(c)],
  ['POST', route(`users/${ID}/role`), (c, body, [id]) => people.setRole(c, id, body)],
  ['POST', route(`users/${ID}/suspend`), (c, body, [id]) => people.suspend(c, id, body)],
  ['POST', route(`users/${ID}/restore`), (c, _body, [id]) => people.restore(c, id)],
  ['POST', route(`users/${ID}/sign-out`), (c, _body, [id]) => people.signOutEverywhere(c, id)],
  ['POST', route(`users/${ID}/delete`), (c, _body, [id]) => people.deleteUser(c, id)],
  ['GET', route('shares'), (c) => shares.listShares(c)],
  ['POST', route(`shares/${ID}/hide`), (c, _body, [id]) => shares.hideShare(c, id)],
  ['DELETE', route(`shares/${ID}`), (c, _body, [id]) => shares.deleteShare(c, id)],
  ['GET', route('bug-reports'), (c) => reports.listReports(c)],
  ['GET', route(`bug-reports/${ID}`), (c, _body, [id]) => reports.getReport(c, id)],
  ['GET', route(`bug-reports/${ID}/files/${FILE}`), (c, _body, [id, name]) => reports.downloadFile(c, id, name)],
  ['PATCH', route(`bug-reports/${ID}`), (c, body, [id]) => reports.setReportStatus(c, id, body)],
  ['DELETE', route(`bug-reports/${ID}`), (c, _body, [id]) => reports.deleteReport(c, id)],
];

/** /api/admin/* */
export async function handleAdminApi(request: Request, env: AdminEnv, ctx: ExecutionContext): Promise<Response> {
  const c = context(request, env, ctx) as AdminContext;
  const path = c.url.pathname.slice('/api/admin/'.length);
  const matches = ROUTES.filter(([, pattern]) => pattern.test(path));
  if (!matches.length) return fail(404, 'not_found', 'No such endpoint.');
  const found = matches.find(([method]) => method === request.method);
  if (!found) return fail(405, 'method_not_allowed', 'Method not allowed.', {}, { Allow: matches.map(([method]) => method).join(', ') });
  const [method, pattern, handler] = found;
  try {
    let body: Json = {};
    if (method !== 'GET') {
      checkSameOrigin(request);
      body = await readJson(request);
    }
    const params = (pattern.exec(path) ?? []).slice(1);
    return withCookies(c, await handler(c, body, params));
  } catch (error) {
    if (error instanceof HttpError) return withCookies(c, fail(error.status, error.code, error.description, error.extra));
    console.error('admin API error', (error as Error)?.stack ?? error);
    return withCookies(c, fail(500, 'server_error', 'Something went wrong. Try again.'));
  }
}
