// Daily unique pi-rust clients, counted from model catalog requests: a GET of
// /api/models/providers/<id> with a pi-rust User-Agent. Each request becomes an HMAC-SHA256 of the client
// IP address, platform, and architecture, keyed with a random salt for the UTC day. The salt is in D1 only
// for its day (the hourly cleanup deletes it after), and the IP address is never stored, so a hash cannot
// be traced back to an address or linked to the same client on another day. The catalog response does not
// wait for any of this. See docs/admin.md.

import { hmacHex, randomToken } from './accounts/crypto';
import type { D1Database, ExecutionContext } from './accounts/env';

export interface CatalogClientEnv {
  DB: D1Database;
}

const PROVIDER_PATH = /^\/api\/models\/providers\/[a-z0-9][a-z0-9._-]{0,63}$/;
/** `pi/0.12.31 (darwin; rust; arm64)`, or `pi-rust/<version>`: the version, then the platform and architecture when present. */
const PI_AGENT = /^pi(?:-rust)?\/([^\s()]{1,100})(?: \(([a-z0-9_]{1,16}); [a-z0-9_]{1,16}; ([a-z0-9_]{1,16})\))?/i;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;

export interface PiAgent {
  version: string;
  platform: string;
  arch: string;
}

/** The version, platform, and architecture in a pi-rust User-Agent; unreadable parts are `unknown`. Undefined for another client. */
export function parsePiAgent(userAgent: string | null | undefined): PiAgent | undefined {
  const match = PI_AGENT.exec(userAgent ?? '');
  if (!match) return undefined;
  return {
    version: VERSION.test(match[1]) ? match[1] : 'unknown',
    platform: match[2]?.toLowerCase() ?? 'unknown',
    arch: match[3]?.toLowerCase() ?? 'unknown',
  };
}

/** A client's hash for one day. The version is left out, so a client that updates during the day stays one client. */
export async function clientHash(salt: string, ip: string, agent: PiAgent): Promise<string> {
  return (await hmacHex(salt, `${ip}\n${agent.platform}\n${agent.arch}`)).slice(0, 32);
}

/** The UTC day of a time, YYYY-MM-DD. */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** This isolate's copy of today's salt. */
let cachedSalt: { day: string; salt: string } | undefined;
/** Clients this isolate already wrote today, so a client that asks for many providers writes one row. */
let written: { day: string; keys: Set<string> } = { day: '', keys: new Set() };
const MAX_WRITTEN = 10_000;

/** The salt for `day`. The first request of the day makes it; every isolate then reads the same one. */
async function daySalt(db: D1Database, day: string): Promise<string> {
  if (cachedSalt?.day === day) return cachedSalt.salt;
  await db.prepare('INSERT OR IGNORE INTO catalog_salts (day, salt) VALUES (?, ?)').bind(day, randomToken()).run();
  const row = await db.prepare('SELECT salt FROM catalog_salts WHERE day = ?').bind(day).first<{ salt: string }>();
  if (!row) throw new Error(`no catalog salt for ${day}`);
  cachedSalt = { day, salt: row.salt };
  return row.salt;
}

/** Adds the client to the day's clients, once per version. */
export async function recordCatalogClient(db: D1Database, ip: string, agent: PiAgent, now = Date.now()): Promise<void> {
  const day = dayOf(now);
  const client = await clientHash(await daySalt(db, day), ip, agent);
  const key = `${client} ${agent.version}`;
  if (written.day !== day || written.keys.size >= MAX_WRITTEN) written = { day, keys: new Set() };
  if (written.keys.has(key)) return;
  await db
    .prepare('INSERT OR IGNORE INTO catalog_clients (day, client, version, platform, arch) VALUES (?, ?, ?, ?, ?)')
    .bind(day, client, agent.version, agent.platform, agent.arch)
    .run();
  written.keys.add(key);
}

/** Counts the client of a catalog request after the response. A failure is logged and never reaches the client. */
export function countCatalogClient(request: Request, env: CatalogClientEnv, ctx: ExecutionContext): void {
  if (request.method !== 'GET' || !PROVIDER_PATH.test(new URL(request.url).pathname)) return;
  const agent = parsePiAgent(request.headers.get('User-Agent'));
  const ip = request.headers.get('CF-Connecting-IP');
  if (!agent || !ip) return;
  ctx.waitUntil(recordCatalogClient(env.DB, ip, agent).catch((error) => console.error('catalog client count failed', (error as Error)?.message)));
}
