// The per-request context the account handlers share, and the row types they read from D1.

import type { AccountEnv, ExecutionContext } from './env';
import { siteOrigin } from './http';

export interface User {
  id: string;
  email: string;
  email_verified_at: number | null;
  password_hash: string;
  totp_secret: string | null;
  totp_pending: string | null;
  totp_enabled_at: number | null;
  totp_last_step: number | null;
  webauthn_user_id: string;
  created_at: number;
  updated_at: number;
  /** 'admin' opens the admin area; see docs/admin.md. */
  role: 'user' | 'admin';
  /** Unix ms; a suspended account cannot sign in. */
  suspended_at: number | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  user_agent: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  reauth_at: number | null;
}

export interface Context {
  request: Request;
  env: AccountEnv;
  ctx: ExecutionContext;
  url: URL;
  /** https://pi-rust.com, or the wrangler dev origin. */
  origin: string;
  /** Set-Cookie values for the response. */
  cookies: string[];
  /** The signed-in session, once loadSession has run. */
  auth?: { session: SessionRow; user: User } | null;
}

export function context(request: Request, env: AccountEnv, ctx: ExecutionContext): Context {
  return { request, env, ctx, url: new URL(request.url), origin: siteOrigin(request), cookies: [] };
}

export function withCookies(c: Context, response: Response): Response {
  if (!c.cookies.length) return response;
  const out = new Response(response.body, response);
  for (const cookie of c.cookies) out.headers.append('Set-Cookie', cookie);
  return out;
}

export async function userById(c: Context, id: string): Promise<User | null> {
  return c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
}

export async function userByEmail(c: Context, email: string): Promise<User | null> {
  return c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
}

export const isoTime = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
