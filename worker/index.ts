/**
 * pi-rust.com Worker. The site is static (dist/, served by the ASSETS binding).
 * The Worker answers /install.sh and /install.ps1, so the install line can
 * read `curl -fsSL https://pi-rust.com/install.sh | sh`. It returns the scripts
 * from the main branch of yannelli/pi-rust unchanged; each script still checks
 * the release archive against SHA256SUMS before it installs anything. It also
 * receives `/bug` reports at /v1/bug-reports (see bug-reports.ts), the opt-in
 * install telemetry ping at /api/report-install (see install-telemetry.ts), and
 * serves the model catalog at /api/models/providers/<id> (see model-catalog.ts),
 * counting each pi-rust client once a day (see catalog-clients.ts).
 * Accounts (accounts/) and session sharing (share/) are described in
 * docs/accounts.md and docs/sharing.md, and the admin area (admin/) in
 * docs/admin.md. An hourly cron trigger deletes expired shares and sign-in rows
 * (see cleanup.ts).
 */

import { handleBugReport, type BugReportEnv } from './bug-reports';
import { countCatalogClient } from './catalog-clients';
import { cleanup } from './cleanup';
import { handleInstallTelemetry, type InstallTelemetryEnv } from './install-telemetry';
import { handleModelCatalog, type ModelCatalogEnv } from './model-catalog';
import { handleDev } from './accounts/dev';
import type { AdminEnv } from './admin/common';
import { handleAdminApi } from './admin/routes';
import type { AccountEnv, ExecutionContext } from './accounts/env';
import { handleAccountApi, handleOAuth, servePage } from './accounts/routes';
import { serveShare } from './share/page';
import { handleShareApi } from './share/routes';

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

export interface Env extends BugReportEnv, InstallTelemetryEnv, ModelCatalogEnv, AccountEnv, AdminEnv {
  ASSETS: Fetcher;
}

const SOURCE = 'https://raw.githubusercontent.com/yannelli/pi-rust/main';
const SCRIPTS: Record<string, string> = { '/install.sh': 'install.sh', '/install.ps1': 'install.ps1' };

/** Seconds to reuse a script. Short, so a fix to an install script reaches people quickly. */
const TTL = 300;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const script = SCRIPTS[url.pathname];
    if (script) return installScript(script, request.method);
    if (url.pathname === '/v1/bug-reports') return handleBugReport(request, env);
    if (url.pathname === '/api/report-install') return handleInstallTelemetry(request, env);
    if (url.pathname.startsWith('/api/models/')) {
      countCatalogClient(request, env, ctx);
      return handleModelCatalog(request, env);
    }
    const accounts = await accountRoute(url.pathname, request, env, ctx);
    if (accounts) return accounts;
    return env.ASSETS.fetch(request);
  },

  /** The cron in wrangler.jsonc. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      cleanup(env).then(
        (deleted) => console.log('cleanup', JSON.stringify(deleted)),
        (error) => console.error('cleanup failed', (error as Error)?.stack ?? error),
      ),
    );
  },
};

/** Accounts, sharing, and the admin area; see docs/accounts.md, docs/sharing.md, and docs/admin.md. */
async function accountRoute(path: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response | undefined> {
  if (path.startsWith('/api/account/')) return handleAccountApi(request, env, ctx);
  if (path.startsWith('/api/admin/')) return handleAdminApi(request, env, ctx);
  if (path.startsWith('/oauth/')) return handleOAuth(request, env, ctx);
  if (path === '/v1/account' || path === '/v1/token' || path === '/v1/shares' || path.startsWith('/v1/shares/')) return handleShareApi(request, env);
  if (path.startsWith('/s/')) return serveShare(request, env, ctx);
  if (path.startsWith('/__dev/')) return handleDev(request, env);
  if (/^\/(account|admin|device|session)(\/|$)/.test(path)) return servePage(request, env, ctx);
  return undefined;
}

async function installScript(name: string, method: string): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const source = `${SOURCE}/${name}`;
  const upstream = await fetch(source, { cf: { cacheTtl: TTL, cacheEverything: true } } as RequestInit);
  if (!upstream.ok) {
    return new Response(`Could not fetch ${name} from GitHub (status ${upstream.status}). Download it from ${source}\n`, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return new Response(method === 'HEAD' ? null : upstream.body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': `public, max-age=${TTL}`,
      'X-Content-Source': source,
      'Access-Control-Allow-Origin': '*',
    },
  });
}
