// Shared HTTP pieces: JSON replies with security headers, the CSRF checks, rate limits, cookies,
// and the site origin.

import type { RateLimit } from '../bug-reports';

export const PRODUCTION_ORIGIN = 'https://pi-rust.com';

export type Json = Record<string, unknown>;

/** Headers on every account API and OAuth response. */
export const API_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
};

/** Headers on the account, device, and sign-in pages. Astro builds their scripts as files, so no inline script runs. */
export const PAGE_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    // Pagefind (site search, in the header) compiles WebAssembly.
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

export function json(status: number, body: Json, headers: HeadersInit = {}): Response {
  const out = new Headers(API_HEADERS);
  for (const [name, value] of new Headers(headers)) out.append(name, value);
  return new Response(JSON.stringify(body), { status, headers: out });
}

export function ok(body: Json = {}, headers?: HeadersInit): Response {
  return json(200, { ok: true, ...body }, headers);
}

export function fail(status: number, error: string, description: string, extra: Json = {}, headers?: HeadersInit): Response {
  return json(status, { ok: false, error, description, ...extra }, headers);
}

export function noContent(headers: HeadersInit = {}): Response {
  const out = new Headers(API_HEADERS);
  out.delete('Content-Type');
  for (const [name, value] of new Headers(headers)) out.append(name, value);
  return new Response(null, { status: 204, headers: out });
}

/** Thrown by handlers to answer with an error; the router turns it into a JSON reply. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly description: string,
    readonly extra: Json = {},
  ) {
    super(description);
  }
}

export function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * The site origin: https://pi-rust.com in production. A request to localhost or 127.0.0.1 can only come
 * from `wrangler dev` (Cloudflare routes production traffic by host name), so there it is the request origin.
 */
export function siteOrigin(request: Request): string {
  const url = new URL(request.url);
  return isLocalHost(url.hostname) ? url.origin : PRODUCTION_ORIGIN;
}

/**
 * CSRF: a state-changing request must be JSON and come from the site origin. JSON needs a CORS preflight
 * cross-site, which the Worker never grants, and the Origin check stops the rest.
 */
export function checkSameOrigin(request: Request): void {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== siteOrigin(request)) throw new HttpError(403, 'bad_origin', 'This request must come from the pi-rust.com site.');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403, 'bad_origin', 'This request must come from the pi-rust.com site.');
}

export async function readJson(request: Request): Promise<Json> {
  const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Send JSON.');
  if (Number(request.headers.get('Content-Length') ?? 0) > 64 * 1024) throw new HttpError(413, 'too_large', 'Request too large.');
  const text = await request.text();
  if (text.length > 64 * 1024) throw new HttpError(413, 'too_large', 'Request too large.');
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Json;
  } catch {
    // Falls through to the error below.
  }
  throw new HttpError(400, 'invalid_json', 'The body is not a JSON object.');
}

export function str(body: Json, key: string, max = 1024): string {
  const value = body[key];
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** Route classes share the AUTH_LIMITER namespace: 10 requests per 60 seconds per client IP and class. */
export type LimitClass = 'sign-in' | 'sign-up' | 'reset' | 'verify' | 'two-step' | 'passkey' | 'reauth' | 'device' | 'email' | 'github';

export async function limit(limiter: RateLimit, key: string): Promise<void> {
  const { success } = await limiter.limit({ key });
  if (!success) throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait a minute and try again.');
}

export function limitAuth(limiter: RateLimit, request: Request, kind: LimitClass): Promise<void> {
  return limit(limiter, `${kind}:${clientIp(request)}`);
}

export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

/** Where to go after sign-in: an account, admin, or device page or a share (/s/<id>) on this site, else the account home. */
export function safeNext(value: string | null): string {
  if (!value || value.startsWith('//') || /[\\\s]/.test(value)) return '/account/';
  if (/^\/(account|admin|device)(\/|\?|$)/.test(value) || /^\/s\/[A-Za-z0-9_-]{22}$/.test(value)) return value;
  return '/account/';
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** A coarse label for a User-Agent, such as "Chrome on macOS". The full string is not stored. */
export function deviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /(Chrome|CriOS|HeadlessChrome)\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /CrOS/.test(ua)
        ? 'ChromeOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
  return os ? `${browser} on ${os}` : browser;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}
