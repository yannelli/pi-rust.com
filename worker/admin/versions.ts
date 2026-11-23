// GET /api/admin/versions: the pi-rust users per day and the versions and platforms they run, from model
// catalog requests. pi-rust 0.12.27 and later read the model catalog from pi-rust.com with
// `User-Agent: pi/<version> (<platform>; rust; <arch>)`, opt-in or not.
//
// - Users come from the catalog_clients table: one row per client, day, and version, where a client is a
//   daily salted hash of its IP address, platform, and architecture (worker/catalog-clients.ts).
// - The request total comes from Cloudflare's HTTP request analytics for the zone (GraphQL Analytics API),
//   when the CLOUDFLARE_ANALYTICS_TOKEN secret is set. The query asks for the count and date only.
// See docs/admin.md.

import { ok } from '../accounts/http';
import { dayOf } from '../catalog-clients';
import { chartStart, count, DAY, DAYS, dayKey, requireAdmin, type AdminContext } from './common';

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

/** Catalog requests from pi-rust, which also answers to `pi-rust/<version>` (worker/model-catalog.ts). */
const QUERY = `query ($zone: String!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      days: httpRequestsAdaptiveGroups(
        limit: 100
        filter: {
          datetime_geq: $start, datetime_lt: $end, clientRequestPath_like: "/api/models/providers/%",
          OR: [{ userAgent_like: "pi/%" }, { userAgent_like: "pi-rust/%" }]
        }
      ) { count }
    }
  }
}`;

interface GraphqlResult {
  data?: { viewer?: { zones?: { days?: { count: number }[] }[] } };
  errors?: { message?: string }[] | null;
}

type Requests = { configured: false } | { configured: true; error: string } | { configured: true; total: number };

/** Catalog requests in the chart's 30 days, as Cloudflare estimates them. */
async function catalogRequests(c: AdminContext, start: number, now: number): Promise<Requests> {
  const zone = c.env.CLOUDFLARE_ZONE_ID;
  const token = c.env.CLOUDFLARE_ANALYTICS_TOKEN;
  if (!zone || !token) return { configured: false };
  try {
    const response = await fetch(GRAPHQL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { zone, start: new Date(start).toISOString(), end: new Date(now).toISOString() } }),
    });
    if (!response.ok) throw new Error(`The Cloudflare GraphQL API answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const result = (await response.json()) as GraphqlResult;
    if (result.errors?.length) throw new Error(result.errors.map((error) => error.message ?? '').join('; ').slice(0, 300));
    const groups = result.data?.viewer?.zones?.[0]?.days ?? [];
    return { configured: true, total: groups.reduce((sum, group) => sum + count(group.count), 0) };
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    console.error('catalog request stats failed', message);
    return {
      configured: true,
      error: /authoriz|permission/i.test(message)
        ? 'Cloudflare refused the request. The CLOUDFLARE_ANALYTICS_TOKEN secret needs Analytics Read on the pi-rust.com zone.'
        : 'Could not read catalog requests from Cloudflare. The Worker log has the details.',
    };
  }
}

/** GET /api/admin/versions */
export async function versions(c: AdminContext): Promise<Response> {
  await requireAdmin(c);
  const now = Date.now();
  const start = chartStart(now);
  const from = dayKey(start);
  const today = dayOf(now);
  const db = c.env.DB;
  const [requests, batch] = await Promise.all([
    catalogRequests(c, start, now),
    db.batch([
      db.prepare('SELECT day, COUNT(DISTINCT client) AS n FROM catalog_clients WHERE day >= ? GROUP BY day').bind(from),
      // A client counts once a day for each version it ran that day; a row is already one client, day, and version.
      db.prepare('SELECT version, COUNT(*) AS n FROM catalog_clients WHERE day >= ? GROUP BY version ORDER BY n DESC, version').bind(from),
      // The hash includes the platform and architecture, so a client has one of each.
      db
        .prepare('SELECT platform, arch, COUNT(*) AS n FROM (SELECT DISTINCT day, client, platform, arch FROM catalog_clients WHERE day >= ?) GROUP BY platform, arch ORDER BY n DESC, platform, arch')
        .bind(from),
      db.prepare('SELECT version, COUNT(DISTINCT client) AS n FROM catalog_clients WHERE day = ? GROUP BY version ORDER BY n DESC, version').bind(today),
      db.prepare('SELECT MIN(day) AS first FROM catalog_clients'),
    ]),
  ]);
  const [days, byVersion, byPlatform, todayByVersion, first] = batch.map((result) => result.results as Record<string, string | number | null>[]);
  const perDay = new Map(days.map((row) => [String(row.day), count(row.n)]));
  return ok({
    users: {
      today: perDay.get(today) ?? 0,
      since: (first[0]?.first as string | null) ?? null,
      days: Array.from({ length: DAYS }, (_, index) => {
        const date = dayKey(start + index * DAY);
        return { date, users: perDay.get(date) ?? 0 };
      }),
      versions: byVersion.map((row) => ({ version: String(row.version), userDays: count(row.n) })),
      platforms: byPlatform.map((row) => ({ platform: String(row.platform), arch: String(row.arch), userDays: count(row.n) })),
      todayVersions: todayByVersion.map((row) => ({ version: String(row.version), users: count(row.n) })),
    },
    requests,
  });
}
