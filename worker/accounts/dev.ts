// Local test support, on only with DEV_MAILBOX=1 and a request to localhost (wrangler dev):
//   GET  /__dev/mailbox?to=<email>   the account email the Worker would have sent, newest first
//   POST /__dev/state                moves a row to a state a test cannot wait for (an expired device
//                                    code, share, or email link, an old re-authentication, an unverified
//                                    address, an admin, a bug report without its row)
//   POST /__dev/cleanup              runs the hourly cleanup now, optionally as of {"now": <ms>}
// Everywhere else they answer 404.

import { cleanup, type CleanupEnv } from '../cleanup';
import { devMailboxOn } from './email';
import { json, type Json } from './http';

export async function handleDev(request: Request, env: CleanupEnv): Promise<Response | undefined> {
  if (!devMailboxOn(env, request)) return undefined;
  const url = new URL(request.url);
  if (url.pathname === '/__dev/mailbox' && request.method === 'GET') {
    const to = (url.searchParams.get('to') ?? '').trim().toLowerCase();
    const { results } = await env.DB.prepare(
      'SELECT to_address AS "to", subject, text, html, created_at AS createdAt FROM dev_mailbox WHERE to_address = ? ORDER BY id DESC LIMIT 50',
    )
      .bind(to)
      .all<Json>();
    return json(200, { ok: true, messages: results });
  }
  if (url.pathname === '/__dev/state' && request.method === 'POST') {
    const body = (await request.json()) as { action?: string; email?: string; userCode?: string; id?: string; at?: number };
    const email = (body.email ?? '').toLowerCase();
    const userCode = (body.userCode ?? '').toUpperCase().replace(/-/g, '');
    // An expiry time to set: `at`, or a second ago.
    const at = typeof body.at === 'number' ? body.at : Date.now() - 1000;
    const statements: Record<string, () => Promise<unknown>> = {
      'expire-device-code': () => env.DB.prepare('UPDATE device_codes SET expires_at = ? WHERE user_code = ?').bind(at, userCode).run(),
      'expire-share': () => env.DB.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').bind(at, body.id ?? '').run(),
      'expire-email-tokens': () =>
        env.DB.prepare('UPDATE email_tokens SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').bind(at, email).run(),
      'age-reauth': () =>
        env.DB.prepare('UPDATE sessions SET reauth_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').bind(Date.now() - 11 * 60 * 1000, email).run(),
      unverify: () => env.DB.prepare('UPDATE users SET email_verified_at = NULL WHERE email = ?').bind(email).run(),
      // Production makes the first admin with `wrangler d1 execute`; see docs/admin.md.
      'make-admin': () => env.DB.prepare("UPDATE users SET role = 'admin' WHERE email = ?").bind(email).run(),
      // A report stored in R2 without its D1 row, as when the row failed to write; the cleanup adds it back.
      'unindex-bug-report': () => env.DB.prepare('DELETE FROM bug_reports WHERE id = ?').bind(body.id ?? '').run(),
    };
    const run = statements[body.action ?? ''];
    if (!run) return json(400, { ok: false, error: 'unknown_action' });
    await run();
    return json(200, { ok: true });
  }
  if (url.pathname === '/__dev/cleanup' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { now?: number };
    return json(200, { ok: true, deleted: await cleanup(env, typeof body.now === 'number' ? body.now : undefined) });
  }
  return undefined;
}
