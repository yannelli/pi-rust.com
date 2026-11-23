// The bindings, variables, and secrets that accounts and sharing use, typed by hand like the rest
// of the Worker (no @cloudflare/workers-types).

import type { RateLimit } from '../bug-reports';

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number; last_row_id?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface R2ObjectBody {
  body: ReadableStream;
  size: number;
}

export interface ShareBucket {
  put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface AccountMailer {
  send(message: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
    html: string;
  }): Promise<{ messageId: string }>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface AccountEnv {
  DB: D1Database;
  SHARES: ShareBucket;
  EMAIL: AccountMailer;
  AUTH_LIMITER: RateLimit;
  SHARE_LIMITER: RateLimit;
  ACCOUNT_EMAIL_FROM: string;
  /** Secret: the HMAC key mixed into password and recovery code hashes. */
  AUTH_PEPPER?: string;
  /** Secret: base64 of 32 bytes, the AES-GCM key for TOTP secrets at rest. */
  TOTP_ENCRYPTION_KEY?: string;
  /** "1" stores email in D1 for tests, and only on localhost. Never set in wrangler.jsonc. */
  DEV_MAILBOX?: string;
}
