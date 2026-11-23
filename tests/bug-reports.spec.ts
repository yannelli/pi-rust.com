import { test, expect, type APIRequestContext } from '@playwright/test';

test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'API tests need one browser project'));

const file = (name: string, mimeType: string, text: string) => ({ name, mimeType, buffer: Buffer.from(text) });

function upload(request: APIRequestContext, fields: Record<string, ReturnType<typeof file>>) {
  return request.post('/v1/bug-reports', { multipart: fields });
}

const report = (id: string) => ({
  'report.json': file('report.json', 'application/json', JSON.stringify({ id, hint: 'it broke', environment: { version: '0.12.21' } })),
  'diagnostics.json': file('diagnostics.json', 'application/json', JSON.stringify({ assistant: [], crashes: [] })),
  'session.jsonl': file('session.jsonl', 'application/x-ndjson', '{"type":"session"}\n'),
});

test('bug reports keep the client report ID and answer with the upstream contract', async ({ request }) => {
  const id = crypto.randomUUID();
  const first = await upload(request, report(id));
  expect(first.status()).toBe(201);
  expect(await first.json()).toEqual({ ok: true, bug_report: { id } });

  const again = await upload(request, report(id));
  expect(again.status()).toBe(201);
  const { bug_report } = await again.json();
  expect(bug_report.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(bug_report.id).not.toBe(id);
});

test('bug reports reject other methods, bodies, and fields', async ({ request }) => {
  const get = await request.get('/v1/bug-reports');
  expect(get.status()).toBe(405);
  expect(await get.json()).toMatchObject({ ok: false, error: 'method_not_allowed' });

  const json = await request.post('/v1/bug-reports', { data: { hint: 'x' } });
  expect(json.status()).toBe(415);

  const extra = await upload(request, { ...report(crypto.randomUUID()), 'notes.txt': file('notes.txt', 'text/plain', 'x') });
  expect(extra.status()).toBe(400);
  expect(await extra.json()).toMatchObject({ ok: false, error: 'invalid_form' });

  const broken = await upload(request, { ...report(crypto.randomUUID()), 'report.json': file('report.json', 'application/json', 'not json') });
  expect(broken.status()).toBe(400);
  expect(await broken.json()).toMatchObject({ ok: false, error: 'invalid_report', description: expect.any(String) });
});
