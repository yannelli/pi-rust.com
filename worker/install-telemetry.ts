// GET /api/report-install?version=<version>: pi-rust's opt-in install and update ping, in the request
// format of upstream pi's pi.dev endpoint. Each ping is one Analytics Engine data point with the version,
// platform, and architecture. The Worker stores no IP address, cookie, or other identifier.

import type { RateLimit } from './bug-reports';

export interface AnalyticsEngineDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface InstallTelemetryEnv {
  INSTALL_TELEMETRY: AnalyticsEngineDataset;
  INSTALL_TELEMETRY_LIMITER: RateLimit;
}

export const INSTALL_TELEMETRY_DATASET = 'pi_rust_install_telemetry';

/** A semantic version, as `pi --version` prints it. */
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;
/** The detailed pi-rust `User-Agent`: `pi/<version> (<platform>; rust; <arch>)`. */
const PI_RUST_USER_AGENT = /^pi\/\S{1,100} \(([a-z0-9_]{1,16}); rust; ([a-z0-9_]{1,16})\)$/;

/** The fields of one ping, in the dataset's blob order: blob1 to blob4. */
export interface InstallPing {
  version: string;
  platform: string;
  arch: string;
  /** `pi-rust` for the pi-rust `User-Agent`, else `other`. */
  client: 'pi-rust' | 'other';
}

function fail(status: number, error: string, description: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error, description }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** The ping in a request, or `undefined` when `version` is missing or not a version. */
export function parsePing(url: URL, userAgent: string | null): InstallPing | undefined {
  const version = url.searchParams.get('version') ?? '';
  if (!VERSION.test(version)) return undefined;
  const match = PI_RUST_USER_AGENT.exec(userAgent ?? '');
  if (!match) return { version, platform: 'unknown', arch: 'unknown', client: 'other' };
  return { version, platform: match[1], arch: match[2], client: 'pi-rust' };
}

export async function handleInstallTelemetry(request: Request, env: InstallTelemetryEnv): Promise<Response> {
  if (request.method !== 'GET') return fail(405, 'method_not_allowed', 'Use GET', { Allow: 'GET' });
  // The limiter counts in memory per Cloudflare location; the address is not stored.
  const { success } = await env.INSTALL_TELEMETRY_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
  if (!success) return fail(429, 'rate_limited', 'Too many pings. Try again in a minute.');
  const ping = parsePing(new URL(request.url), request.headers.get('User-Agent'));
  if (!ping) return fail(400, 'invalid_version', 'Send the pi-rust version as ?version=<major>.<minor>.<patch>');
  env.INSTALL_TELEMETRY.writeDataPoint({
    blobs: [ping.version, ping.platform, ping.arch, ping.client],
    indexes: [ping.version],
  });
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
