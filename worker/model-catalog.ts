// GET /api/models/providers/<id>: the model catalog of pi-rust releases, in the protocol of upstream
// pi's pi.dev catalog (`scripts/model-catalog-protocol.ts` in earendil-works/pi), with pi-rust
// versions. The pi-rust repository publishes revisions to its `model-catalog` branch
// (docs/model-catalog.md there). This route picks the revision for the client's version and serves
// one provider with Last-Modified and ETag, so clients revalidate cheaply.

export interface ModelCatalogEnv {
  /** Base URL of `models/v1` on the model-catalog branch. Tests point it elsewhere. */
  MODEL_CATALOG_SOURCE?: string;
}

export const DEFAULT_MODEL_CATALOG_SOURCE = 'https://raw.githubusercontent.com/yannelli/pi-rust/model-catalog/models/v1';

export type SourceFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface CatalogEntry {
  minimumPiVersion: string;
  revision: string;
  publishedAt: string;
}

interface CatalogIndex {
  defaultRevision: string;
  catalogs: CatalogEntry[];
}

const PROVIDER_PATH = /^\/api\/models\/providers\/([a-z0-9][a-z0-9._-]{0,63})$/;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
/** `pi/<version> (...)` as pi-rust sends it to its own services, or `pi-rust/<version> (...)`. */
const USER_AGENT_VERSION = /^pi(?:-rust)?\/([^\s()]+)/i;
const MODEL_TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVISION = /^sha256-[0-9a-f]{64}$/;
/** The index changes when a catalog is published; revisions never change. */
const INDEX_TTL = 300;
const REVISION_TTL = 86_400;
const CLIENT_MAX_AGE = 300;

type Parsed = readonly [number, number, number, string];

function parseVersion(version: string): Parsed | undefined {
  const match = VERSION.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''] : undefined;
}

/** Semver precedence without build metadata; a prerelease sorts before its release. */
export function compareVersions(left: Parsed, right: Parsed): number {
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return (left[index] as number) - (right[index] as number);
  if (left[3] === right[3]) return 0;
  if (!left[3]) return 1;
  if (!right[3]) return -1;
  return left[3] < right[3] ? -1 : 1;
}

/** The entry with the highest minimum version at or below `version`; the default without a version. */
export function selectCatalog(index: CatalogIndex, version: string | undefined): CatalogEntry | undefined {
  if (version === undefined) return index.catalogs.find((entry) => entry.revision === index.defaultRevision);
  const requested = parseVersion(version);
  if (!requested) return undefined;
  let selected: { entry: CatalogEntry; minimum: Parsed } | undefined;
  for (const entry of index.catalogs) {
    const minimum = parseVersion(entry.minimumPiVersion);
    if (!minimum || compareVersions(minimum, requested) > 0) continue;
    if (!selected || compareVersions(minimum, selected.minimum) > 0) selected = { entry, minimum };
  }
  return selected?.entry;
}

/** The client's version: `?pi-version=`, else the `User-Agent`. `null` when `pi-version` is invalid. */
export function clientVersion(url: URL, userAgent: string | null): string | undefined | null {
  const explicit = url.searchParams.get('pi-version');
  if (explicit !== null) return parseVersion(explicit) ? explicit : null;
  const fromAgent = USER_AGENT_VERSION.exec(userAgent ?? '')?.[1];
  return fromAgent && parseVersion(fromAgent) ? fromAgent : undefined;
}

/** `typed` with `?types=` (every model type), `legacy` without it (chat only), `undefined` when invalid. */
export function representation(types: string | null): 'typed' | 'legacy' | undefined {
  if (types === null) return 'legacy';
  if (types === '' || types.split(',').some((type) => !MODEL_TYPE.test(type))) return undefined;
  return 'typed';
}

function isIndex(value: unknown): value is CatalogIndex {
  const index = value as CatalogIndex;
  return (
    !!index &&
    typeof index.defaultRevision === 'string' &&
    Array.isArray(index.catalogs) &&
    index.catalogs.every(
      (entry) =>
        typeof entry?.minimumPiVersion === 'string' && typeof entry.revision === 'string' && typeof entry.publishedAt === 'string',
    )
  );
}

function fail(status: number, error: string, description: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error, description }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function fromSource(fetcher: SourceFetch, url: string, ttl: number): Promise<Response> {
  return fetcher(url, { cf: { cacheTtl: ttl, cacheEverything: true } } as RequestInit);
}

export async function handleModelCatalog(request: Request, env: ModelCatalogEnv, fetcher: SourceFetch = fetch): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed', 'Use GET', { Allow: 'GET, HEAD' });
  const url = new URL(request.url);
  const provider = PROVIDER_PATH.exec(url.pathname)?.[1];
  if (!provider) return fail(404, 'unknown_provider', 'No such provider');
  const variant = representation(url.searchParams.get('types'));
  if (!variant) return fail(400, 'invalid_types', 'Invalid model types');
  const version = clientVersion(url, request.headers.get('User-Agent'));
  if (version === null) return fail(400, 'invalid_version', 'Invalid pi version');

  const source = (env.MODEL_CATALOG_SOURCE || DEFAULT_MODEL_CATALOG_SOURCE).replace(/\/+$/, '');
  const indexResponse = await fromSource(fetcher, `${source}/index.json`, INDEX_TTL);
  if (!indexResponse.ok) return fail(503, 'catalog_unavailable', 'The model catalog is not available', { 'Retry-After': '300' });
  const index: unknown = await indexResponse.json().catch(() => undefined);
  if (!isIndex(index)) return fail(503, 'catalog_unavailable', 'The model catalog is not available', { 'Retry-After': '300' });
  const entry = selectCatalog(index, version);
  if (!entry || !REVISION.test(entry.revision)) return fail(404, 'no_catalog', 'No catalog for this version');

  const published = new Date(entry.publishedAt);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ETag: `"${entry.revision}-${variant}"`,
    'Cache-Control': `public, max-age=${CLIENT_MAX_AGE}`,
    Vary: 'User-Agent',
    'Access-Control-Allow-Origin': '*',
  };
  if (!Number.isNaN(published.getTime())) headers['Last-Modified'] = published.toUTCString();
  const tags = (request.headers.get('If-None-Match') ?? '').split(',').map((tag) => tag.trim().replace(/^W\//, ''));
  if (tags.includes(headers.ETag) || tags.includes('*')) return new Response(null, { status: 304, headers });

  const file = `${provider}${variant === 'typed' ? '.all.json' : '.json'}`;
  const body = await fromSource(fetcher, `${source}/revisions/${entry.revision}/providers/${file}`, REVISION_TTL);
  if (body.status === 404) return fail(404, 'unknown_provider', 'No such provider');
  if (!body.ok) return fail(503, 'catalog_unavailable', 'The model catalog is not available', { 'Retry-After': '300' });
  return new Response(request.method === 'HEAD' ? null : body.body, { headers });
}
