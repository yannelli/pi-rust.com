import { test, expect } from '@playwright/test';
import { parsePing } from '../worker/install-telemetry';

test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'API tests need one browser project'));

const PI_RUST = 'pi/0.12.26 (linux; rust; x64)';

test('install pings answer 204 with the upstream request format', async ({ request }) => {
  const ping = await request.get('/api/report-install?version=0.12.26', { headers: { 'User-Agent': PI_RUST } });
  expect(ping.status()).toBe(204);
  expect(ping.headers()['cache-control']).toBe('no-store');

  const other = await request.get('/api/report-install?version=1.2.3-beta%2B1', { headers: { 'User-Agent': 'curl/8' } });
  expect(other.status()).toBe(204);
});

test('install pings reject other methods and bad versions', async ({ request }) => {
  const post = await request.post('/api/report-install?version=0.12.26');
  expect(post.status()).toBe(405);
  expect(post.headers()['allow']).toBe('GET');

  const missing = await request.get('/api/report-install', { headers: { 'User-Agent': PI_RUST } });
  expect(missing.status()).toBe(400);
  expect(await missing.json()).toMatchObject({ ok: false, error: 'invalid_version', description: expect.any(String) });

  const junk = await request.get('/api/report-install?version=latest%3Cscript%3E', { headers: { 'User-Agent': PI_RUST } });
  expect(junk.status()).toBe(400);
});

test('install pings record only the version, platform, and architecture', () => {
  const url = (version: string) => new URL(`https://pi-rust.com/api/report-install?version=${encodeURIComponent(version)}`);
  expect(parsePing(url('0.12.26'), 'pi/0.12.26 (darwin; rust; arm64)')).toEqual({
    version: '0.12.26',
    platform: 'darwin',
    arch: 'arm64',
    client: 'pi-rust',
  });
  expect(parsePing(url('1.2.3-beta+1'), 'pi/1.2.3 (linux; node 22.1.0; x64)')).toEqual({
    version: '1.2.3-beta+1',
    platform: 'unknown',
    arch: 'unknown',
    client: 'other',
  });
  expect(parsePing(url('0.12.26'), null)?.client).toBe('other');
  expect(parsePing(url('1.2'), PI_RUST)).toBeUndefined();
  expect(parsePing(url('x'.repeat(200)), PI_RUST)).toBeUndefined();
});
