// GET /s/<id>: serves a share in a CSP sandbox. It answers 404 for an unknown, deleted, or (to anyone
// but its signed-in owner) private share, all with the same page, 410 for an expired one, and counts
// views. Shares are never indexed.

import { sha256 } from '../accounts/crypto';
import type { AccountEnv, ExecutionContext } from '../accounts/env';
import { readCookie } from '../accounts/http';
import { SESSION_COOKIE } from '../accounts/sessions';
import { deleteExpiredShares, getShare, isExpired, SHARE_ID, shareKey, type ShareRow } from './store';

/** On every /s/ and /session/ response, including errors and redirects. */
export const NO_INDEX = 'noindex, nofollow, noarchive, nosnippet, noimageindex';

/** A share runs in a sandbox with an opaque origin, so it can never read pi-rust.com cookies or call its APIs. */
const SHARE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
  'X-Robots-Tag': NO_INDEX,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-cache',
};

const NOTICE_HEADERS: Record<string, string> = { ...SHARE_HEADERS, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" };

/** Link-preview fetchers. Their requests are not views. */
const PREVIEW_BOTS = /Slackbot|Discordbot|Twitterbot|facebookexternalhit|LinkedInBot|TelegramBot|WhatsApp/i;

const ROBOTS_META = '<meta name="robots" content="noindex, nofollow, noarchive">';
const PREVIEW_DESCRIPTION = 'A pi session shared on pi-rust.com';

/** A small page. `body` is trusted HTML. */
function noticePage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>${ROBOTS_META}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | pi-rust</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#171717;font:16px/1.6 ui-sans-serif,system-ui,sans-serif}main{padding:24px;text-align:center}h1{margin:0 0 8px;font-size:20px;font-weight:600}p{margin:0;color:#4d4d4d}p+p{margin-top:8px}a{color:inherit}@media (prefers-color-scheme:dark){body{background:#0a0a0a;color:#ededed}p{color:#a1a1a1}}</style></head>
<body><main><h1>${title}</h1>${body}</main></body>
</html>
`;
}

/**
 * The one 404 page for an unknown, deleted, or private share, so a private share looks like any missing
 * one. Its sign-in link comes back to the requested /s/<id>, so an owner who is signed out gets to a
 * private share in one step. The ID is only put in the page when it has the share ID form.
 */
function notFoundPage(id: string): string {
  const signIn = SHARE_ID.test(id) ? `/account/sign-in/?next=/s/${id}` : '/account/sign-in/';
  return noticePage(
    'Share not found',
    `<p>It was deleted, or the link is wrong. If it’s your share, sign in to open it.</p><p><a href="${signIn}">Sign in</a> · <a href="/">pi-rust.com</a></p>`,
  );
}

const EXPIRED_PAGE = noticePage('Share expired', '<p>This share expired. <a href="/">pi-rust.com</a></p>');

function notice(request: Request, status: number, page: string): Response {
  return new Response(request.method === 'HEAD' ? null : page, { status, headers: NOTICE_HEADERS });
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "Fix the parser!" becomes "fix-the-parser"; a title with no letters or digits becomes "pi-session". */
export function fileSlug(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '');
  return slug || 'pi-session';
}

/** The robots tag for every share, and a link preview for shares anyone with the link can open. */
function headTags(row: ShareRow): string {
  if (row.visibility !== 'link') return ROBOTS_META;
  const meta = (attr: 'name' | 'property', key: string, value: string) => `<meta ${attr}="${key}" content="${escapeAttr(value)}">`;
  return [
    ROBOTS_META,
    meta('property', 'og:title', row.title),
    meta('property', 'og:description', PREVIEW_DESCRIPTION),
    meta('property', 'og:site_name', 'pi-rust'),
    meta('property', 'og:type', 'article'),
    meta('name', 'twitter:card', 'summary'),
  ].join('');
}

interface RewriterElement {
  before(content: string, options?: { html?: boolean }): void;
  prepend(content: string, options?: { html?: boolean }): void;
}

declare const HTMLRewriter: {
  new (): {
    on(selector: string, handlers: { element?(element: RewriterElement): void }): InstanceType<typeof HTMLRewriter>;
    transform(response: Response): Response;
  };
};

/**
 * Puts `tags` first in <head>. A page without a <head> tag gets them before its <body> or <title>, where
 * the HTML parser still places them in the head.
 */
function insertHeadTags(response: Response, tags: string): Response {
  let done = false;
  const place = (where: 'prepend' | 'before') => ({
    element(element: RewriterElement) {
      if (done) return;
      done = true;
      element[where](tags, { html: true });
    },
  });
  return new HTMLRewriter().on('head', place('prepend')).on('title', place('before')).on('body', place('before')).transform(response);
}

/** The signed-in user of the request's browser session and their role, or null. Read only: it does not extend the session. */
async function sessionUser(request: Request, env: AccountEnv, now: number): Promise<{ id: string; admin: boolean } | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const row = await env.DB.prepare(
    'SELECT users.id, users.role FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.suspended_at IS NULL',
  )
    .bind(await sha256(token), now)
    .first<{ id: string; role: string }>();
  return row ? { id: row.id, admin: row.role === 'admin' } : null;
}

function logFailure(what: string) {
  return (error: unknown) => console.error(what, (error as Error)?.message ?? error);
}

/** GET or HEAD /s/<id>, and /s/<id>?download=1 for a file. */
export async function serveShare(request: Request, env: AccountEnv, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed\n', { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': NO_INDEX } });
  }
  const url = new URL(request.url);
  const id = url.pathname.slice('/s/'.length).replace(/\/$/, '');
  const notFound = () => notice(request, 404, notFoundPage(id));
  const row = await getShare(env, id);
  if (!row) return notFound();

  const now = Date.now();
  const expired = isExpired(row, now);
  if (expired) ctx.waitUntil(deleteExpiredShares(env, { ids: [row.id], now }).catch(logFailure('expired share cleanup failed')));
  const viewer = await sessionUser(request, env, now);
  const owner = viewer?.id === row.user_id;
  // To anyone but its signed-in owner, a private share, live or expired, is the same 404 as an unknown ID.
  if (row.visibility === 'private' && !owner) return notFound();
  if (expired) return notice(request, 410, EXPIRED_PAGE);

  const object = await env.SHARES.get(shareKey(row.id));
  if (!object) return notFound();
  const download = url.searchParams.get('download') === '1';
  // Admins open shares to check them; that is not a view either.
  if (request.method === 'GET' && !owner && !viewer?.admin && !PREVIEW_BOTS.test(request.headers.get('User-Agent') ?? '')) {
    ctx.waitUntil(
      env.DB.prepare('UPDATE shares SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?').bind(now, row.id).run().catch(logFailure('share view count failed')),
    );
  }
  const headers = download ? { ...SHARE_HEADERS, 'Content-Disposition': `attachment; filename="${fileSlug(row.title)}.html"` } : SHARE_HEADERS;
  if (request.method === 'HEAD') return new Response(null, { headers });
  // A download is the file as it was uploaded.
  if (download) return new Response(object.body, { headers });
  return insertHeadTags(new Response(object.body, { headers }), headTags(row));
}
