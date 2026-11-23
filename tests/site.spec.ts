import { test, expect, type Page } from '@playwright/test';

async function jsonLd(page: Page) {
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  return blocks.flatMap((text) => (JSON.parse(text)['@graph'] ?? []) as Record<string, unknown>[]);
}

const hasType = (node: Record<string, unknown>, type: string) => [node['@type']].flat().includes(type);

test('home renders the hero, install line, and software schema without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The pi coding agent, ported 1:1 to Rust.');
  // The drop-in section shows the parity report rows synced from the repo.
  await expect(page.locator('#drop-in .parity dt')).toHaveText(['CLI flags', 'Slash commands', 'Built-in tools', 'Extension API']);
  await expect(page.locator('[data-picker] code').first()).toContainText('pi-rust.com/install');
  const nodes = await jsonLd(page);
  const software = nodes.find((node) => hasType(node, 'SoftwareApplication'));
  expect(software).toMatchObject({ name: 'pi-rust', codeRepository: 'https://github.com/yannelli/pi-rust', programmingLanguage: 'Rust' });
  expect(software?.author).toMatchObject({ '@id': 'https://ryanyannelli.com/#person', name: 'Ryan Yannelli' });
  expect(software?.featureList).toEqual(expect.arrayContaining([expect.stringContaining('Drop-in replacement for pi')]));
  expect(errors).toEqual([]);
});

test('every page credits and links ryanyannelli.com', async ({ page }) => {
  for (const path of ['/', '/docs/cli/', '/install/', '/faq/']) {
    await page.goto(path);
    await expect(page.locator('footer a[href="https://ryanyannelli.com/"]').first()).toBeAttached();
    await expect(page.locator('footer a[href="https://ryanyannelli.com/projects/pi-rust/"]')).toBeAttached();
  }
});

test('every sitemap URL is its own canonical, indexable, and has a social card', async ({ request }) => {
  test.skip(test.info().project.name !== 'desktop', 'once is enough');
  const index = await (await request.get('/sitemap-index.xml')).text();
  const child = index.match(/https:\/\/pi-rust\.com\/(sitemap-\d+\.xml)/)![1];
  const xml = await (await request.get(`/${child}`)).text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(locs.length).toBeGreaterThan(20);
  const failures: string[] = [];
  for (const loc of locs) {
    const html = await (await request.get(new URL(loc).pathname)).text();
    if (html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] !== loc) failures.push(`${loc}: canonical`);
    if (/noindex/.test(html)) failures.push(`${loc}: noindex`);
    const image = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
    if (!image || !(await request.get(new URL(image).pathname)).ok()) failures.push(`${loc}: social card ${image}`);
    // Link previews on X, Facebook, LinkedIn, Slack, and Discord read these.
    for (const tag of ['property="og:title"', 'property="og:description"', 'property="og:image:alt"', 'name="twitter:image:alt"', 'name="twitter:site"']) {
      if (!new RegExp(`<meta ${tag} content="[^"]+"`).test(html)) failures.push(`${loc}: missing ${tag}`);
    }
    if (!html.includes('<meta name="twitter:card" content="summary_large_image"')) failures.push(`${loc}: twitter:card`);
    if (html.match(/<meta name="twitter:image" content="([^"]+)"/)?.[1] !== image) failures.push(`${loc}: twitter:image differs from og:image`);
    const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
    if (description.length < 50 || description.length > 170) failures.push(`${loc}: description length ${description.length}`);
  }
  expect(failures, failures.join('\n')).toEqual([]);
});

test('no word runs into an inline code, link, or bold tag', async ({ request }) => {
  test.skip(test.info().project.name !== 'desktop', 'once is enough');
  // Astro drops the space when a line of text wraps onto an inline element (JSX rules): "asANTHROPIC_API_KEY".
  // A plural on code ("`$ref`s") is written that way on purpose, so a closing tag followed by "s" passes.
  const index = await (await request.get('/sitemap-index.xml')).text();
  const child = index.match(/https:\/\/pi-rust\.com\/(sitemap-\d+\.xml)/)![1];
  const locs = [...(await (await request.get(`/${child}`)).text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const glued: string[] = [];
  for (const loc of [...locs, 'https://pi-rust.com/no-such-page/']) {
    const html = (await (await request.get(new URL(loc).pathname)).text()).replace(/<(script|style|pre)\b[\s\S]*?<\/\1>/g, '');
    for (const m of html.matchAll(/[A-Za-z,;:)]<(code|a|strong)\b[^>]*>([^<]{0,20})/g)) glued.push(`${loc}: …${m[0]}`);
    for (const m of html.matchAll(/<\/(code|a|strong)>([A-Za-rt-z(][^<]{0,12})/g)) glued.push(`${loc}: ${m[0]}…`);
  }
  expect(glued, glued.join('\n')).toEqual([]);
});

test('the docs page shows the menu, breadcrumb, and source note', async ({ page }) => {
  await page.goto('/docs/rpc/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('RPC mode');
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Editors and tools');
  await expect(page.locator('.docs__source a')).toHaveAttribute('href', /github\.com\/yannelli\/pi-rust\/blob\/(v[\d.]+|main)\/crates\/pi-coding-agent\/docs\/rpc\.md/);
});

test('search finds a flag from the docs', async ({ page }) => {
  await page.goto('/docs/');
  await page.keyboard.press('/');
  const input = page.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill('max-cost');
  await expect(page.getByRole('option').first()).toBeVisible();
  await expect(page.getByRole('listbox')).toContainText(/CLI commands and flags/);
  // Rows are styled (the styles reach markup built in the browser) and link to the matching section.
  const options = page.getByRole('option');
  await expect(options.first()).toHaveCSS('text-decoration-line', 'none');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  expect(await options.evaluateAll((links) => links.some((a) => (a as HTMLAnchorElement).hash))).toBe(true);
  await input.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
});

test('the install picker switches platform and remembers it', async ({ page }) => {
  await page.goto('/install/');
  // Each tab shows its OS icon and name; the stacked labels for no-JS visitors are hidden.
  await expect(page.getByRole('tab', { name: 'macOS' }).locator('svg')).toBeVisible();
  await expect(page.locator('[data-picker-label]').first()).toBeHidden();
  await page.getByRole('tab', { name: 'Linux' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('brew install yannelli/tap/pi');
  await page.getByRole('tab', { name: 'Windows' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('irm https://pi-rust.com/install.ps1 | iex');
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Windows' })).toHaveAttribute('aria-selected', 'true');
});

test('the FAQ carries FAQPage schema that matches the page', async ({ page }) => {
  await page.goto('/faq/');
  const faq = (await jsonLd(page)).find((node) => hasType(node, 'FAQPage'));
  const questions = (faq?.mainEntity ?? []) as { name: string }[];
  expect(questions.length).toBeGreaterThan(10);
  for (const { name } of questions) await expect(page.getByRole('heading', { name, exact: true })).toBeAttached();
});

test('llms.txt and robots.txt are served for crawlers', async ({ request }) => {
  const llms = await (await request.get('/llms.txt')).text();
  expect(llms).toContain('# pi-rust');
  expect(llms).toContain('https://pi-rust.com/docs/quick-start/');
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Sitemap: https://pi-rust.com/sitemap-index.xml');
});

test('unknown pages are noindex', async ({ page }) => {
  await page.goto('/no-such-page/');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');
});

test('no page scrolls sideways on a phone', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'phone layout only');
  for (const path of ['/', '/install/', '/docs/providers/', '/benchmarks/', '/changelog/', '/faq/', '/privacy/', '/terms/']) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});

test('docs show keyboard keys as kbd, and only where they are keys', async ({ page }) => {
  await page.goto('/docs/commands/');
  // "press Ctrl+Enter" becomes one group of two keys.
  const combo = page.locator('.prose .kbd-group', { hasText: 'Ctrl+Enter' }).first();
  await expect(combo.locator('.kbd')).toHaveText(['Ctrl', 'Enter']);
  // The key table's first column is keys; code and headings never are.
  await expect(page.locator('.prose td:first-child .kbd', { hasText: /^Page Down$/ })).toHaveCount(1);
  await expect(page.locator('.prose :is(h2, h3, code, pre) .kbd')).toHaveCount(0);
});
