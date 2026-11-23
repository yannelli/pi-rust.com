import { test, expect } from '@playwright/test';
import { handleModelCatalog, selectCatalog, type SourceFetch } from '../worker/model-catalog';

test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'API tests need one browser project'));

const OLD = `sha256-${'a'.repeat(64)}`;
const NEW = `sha256-${'b'.repeat(64)}`;
const SOURCE = 'https://catalog.test/models/v1';
const INDEX = {
  schemaVersion: 1,
  defaultRevision: NEW,
  catalogs: [
    { minimumPiVersion: '0.7.0', revision: OLD, publishedAt: '2026-11-01T10:00:00.000Z' },
    { minimumPiVersion: '0.13.0', revision: NEW, publishedAt: '2026-11-22T22:26:33.503Z' },
  ],
};

/** A fake model-catalog branch: the index plus anthropic in both revisions. */
function source(index: unknown = INDEX): { fetch: SourceFetch; urls: string[] } {
  const urls: string[] = [];
  const files: Record<string, unknown> = { [`${SOURCE}/index.json`]: index };
  for (const revision of [OLD, NEW]) {
    files[`${SOURCE}/revisions/${revision}/providers/anthropic.all.json`] = [{ id: `all-${revision.slice(7, 8)}`, type: 'chat' }];
    files[`${SOURCE}/revisions/${revision}/providers/anthropic.json`] = { [`chat-${revision.slice(7, 8)}`]: {} };
  }
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      return url in files ? Response.json(files[url]) : new Response('Not found', { status: 404 });
    },
  };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://pi-rust.com${path}`, { headers });
}

test('catalog requests get the revision for the client version', async () => {
  const { fetch } = source();
  const env = { MODEL_CATALOG_SOURCE: SOURCE };
  const typed = await handleModelCatalog(get('/api/models/providers/anthropic?types=chat,image,classifier', { 'User-Agent': 'pi/0.12.26 (linux; rust; x64)' }), env, fetch);
  expect(typed.status).toBe(200);
  expect(await typed.json()).toEqual([{ id: 'all-a', type: 'chat' }]);
  expect(typed.headers.get('etag')).toBe(`"${OLD}-typed"`);
  expect(typed.headers.get('last-modified')).toBe('Sun, 01 Nov 2026 10:00:00 GMT');
  expect(typed.headers.get('vary')).toBe('User-Agent');

  const legacy = await handleModelCatalog(get('/api/models/providers/anthropic', { 'User-Agent': 'pi-rust/0.13.1 (darwin; rust; arm64)' }), env, fetch);
  expect(await legacy.json()).toEqual({ 'chat-b': {} });

  const explicit = await handleModelCatalog(get('/api/models/providers/anthropic?types=chat&pi-version=0.13.0'), env, fetch);
  expect(explicit.headers.get('etag')).toBe(`"${NEW}-typed"`);
  const anonymous = await handleModelCatalog(get('/api/models/providers/anthropic?types=chat', { 'User-Agent': 'curl/8' }), env, fetch);
  expect(anonymous.headers.get('etag')).toBe(`"${NEW}-typed"`);
});

test('catalog requests revalidate with ETag and reject bad input', async () => {
  const { fetch, urls } = source();
  const env = { MODEL_CATALOG_SOURCE: SOURCE };
  const agent = { 'User-Agent': 'pi/0.13.0 (linux; rust; x64)' };
  const fresh = await handleModelCatalog(get('/api/models/providers/anthropic?types=chat', { ...agent, 'If-None-Match': `"${NEW}-typed"` }), env, fetch);
  expect(fresh.status).toBe(304);
  expect(urls).toEqual([`${SOURCE}/index.json`]);

  expect((await handleModelCatalog(get('/api/models/providers/nope?types=chat', agent), env, fetch)).status).toBe(404);
  expect((await handleModelCatalog(get('/api/models/providers/anthropic?types=', agent), env, fetch)).status).toBe(400);
  expect((await handleModelCatalog(get('/api/models/providers/anthropic?pi-version=latest'), env, fetch)).status).toBe(400);
  expect((await handleModelCatalog(get('/api/models/providers/anthropic', { 'User-Agent': 'pi/0.6.9' }), env, fetch)).status).toBe(404);
  expect((await handleModelCatalog(get('/api/models/providers/..%2Fsecrets'), env, fetch)).status).toBe(404);
  expect((await handleModelCatalog(new Request('https://pi-rust.com/api/models/providers/anthropic', { method: 'POST' }), env, fetch)).status).toBe(405);

  const broken = source({ catalogs: 'nope' });
  const unavailable = await handleModelCatalog(get('/api/models/providers/anthropic', agent), env, broken.fetch);
  expect(unavailable.status).toBe(503);
});

test('selection picks the highest minimum version at or below the client', () => {
  expect(selectCatalog(INDEX, '0.7.0')?.revision).toBe(OLD);
  expect(selectCatalog(INDEX, '0.13.0-beta.1')?.revision).toBe(OLD);
  expect(selectCatalog(INDEX, '1.0.0')?.revision).toBe(NEW);
  expect(selectCatalog(INDEX, '0.6.0')).toBeUndefined();
  expect(selectCatalog(INDEX, undefined)?.revision).toBe(NEW);
});

test('the Worker routes catalog requests', async ({ request }) => {
  const invalid = await request.get('/api/models/providers/anthropic?types=', { headers: { 'User-Agent': 'pi/0.12.26 (linux; rust; x64)' } });
  expect(invalid.status()).toBe(400);
  expect(await invalid.json()).toMatchObject({ ok: false, error: 'invalid_types' });
  const post = await request.post('/api/models/providers/anthropic');
  expect(post.status()).toBe(405);
});
