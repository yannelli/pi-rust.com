// The daily client count's pure parts: reading a pi-rust User-Agent and the client hash.

import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { clientHash, parsePiAgent } from '../worker/catalog-clients';

test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'unit tests need one browser project'));

test('reads the version, platform, and architecture of a pi-rust User-Agent', () => {
  expect(parsePiAgent('pi/0.12.31 (darwin; rust; arm64)')).toEqual({ version: '0.12.31', platform: 'darwin', arch: 'arm64' });
  expect(parsePiAgent('pi-rust/1.2.3-beta.1')).toEqual({ version: '1.2.3-beta.1', platform: 'unknown', arch: 'unknown' });
  expect(parsePiAgent('pi/main (Linux; rust; X64)')).toEqual({ version: 'unknown', platform: 'linux', arch: 'x64' });
  expect(parsePiAgent('curl/8.5.0')).toBeUndefined();
  expect(parsePiAgent('Mozilla/5.0 pi/1.0.0')).toBeUndefined();
  expect(parsePiAgent(null)).toBeUndefined();
});

test('a client hash covers the address, platform, and architecture, not the version, and changes with the salt', async () => {
  const agent = parsePiAgent('pi/0.12.31 (darwin; rust; arm64)')!;
  const hash = await clientHash('salt-a', '203.0.113.7', agent);
  // HMAC-SHA256(salt, "<ip>\n<platform>\n<arch>"), the first 32 hex characters.
  expect(hash).toBe(createHmac('sha256', 'salt-a').update('203.0.113.7\ndarwin\narm64').digest('hex').slice(0, 32));
  expect(await clientHash('salt-a', '203.0.113.7', { ...agent, version: '0.12.30' })).toBe(hash);
  expect(await clientHash('salt-b', '203.0.113.7', agent)).not.toBe(hash);
  expect(await clientHash('salt-a', '203.0.113.8', agent)).not.toBe(hash);
  expect(await clientHash('salt-a', '203.0.113.7', { ...agent, arch: 'x64' })).not.toBe(hash);
});
