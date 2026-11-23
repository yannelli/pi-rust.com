// npm run sync → pulls the pi-rust docs, README sections, changelog, benchmark,
// and release metadata at the latest release tag into src/content/docs and src/data.
//
// The site states nothing the repository does not, so every page body comes from
// the repository at one tag. Relative links are rewritten: a link to a synced page
// goes to that page here, and any other link goes to the file on GitHub at the tag.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';

const REPO = 'yannelli/pi-rust';
const root = new URL('../', import.meta.url);
const headers = { 'User-Agent': 'pi-rust.com-sync', Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const api = async (path) => {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status}`);
  return response.json();
};

const release = await api('/releases/latest');
const repo = await api('');
const tag = release.tag_name;

const tagCommit = await api(`/commits/${tag}`);
const tagDate = tagCommit.commit.committer.date;

/**
 * The ref to read a doc from: main when every commit that touched the file after the
 * release is a docs commit (a wording fix), so the fix reaches the site without a new
 * release. A file changed by a feature or fix commit stays at the release tag, so the
 * site never describes something the release does not have.
 */
async function refFor(path) {
  // PI_RUST_REF=<branch> previews docs from a branch before it merges. Do not commit its output.
  if (process.env.PI_RUST_REF) return process.env.PI_RUST_REF;
  const commits = await api(`/commits?sha=main&path=${encodeURIComponent(path)}&since=${tagDate}&per_page=100`);
  const after = commits.filter((c) => c.sha !== tagCommit.sha && !/^Merge (pull request|branch)/.test(c.commit.message));
  if (!after.length) return tag;
  return after.every((c) => /^docs(\([^)]*\))?:/.test(c.commit.message)) ? 'main' : tag;
}

const raw = async (path, ref = tag) => {
  const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${ref}/${path}`);
  if (!response.ok) throw new Error(`${path} at ${ref}: ${response.status}`);
  return response.text();
};
const refs = {};

/**
 * Pages built from whole files. `group` and `order` place them in the docs nav.
 * Install renders at /install/, every other page at /docs/<slug>/.
 */
const FILES = [
  { path: 'crates/pi-coding-agent/docs/install.md', slug: 'install', group: 'Get started', order: 2, title: 'Install pi-rust' },
  { path: 'crates/pi-coding-agent/docs/commands.md', slug: 'commands', group: 'Use pi', order: 10 },
  { path: 'crates/pi-coding-agent/docs/cli.md', slug: 'cli', group: 'Use pi', order: 11 },
  { path: 'crates/pi-coding-agent/docs/settings.md', slug: 'settings', group: 'Use pi', order: 12 },
  { path: 'crates/pi-coding-agent/docs/terminal.md', slug: 'terminal', group: 'Use pi', order: 13 },
  { path: 'crates/pi-coding-agent/docs/status-line.md', slug: 'status-line', group: 'Use pi', order: 14 },
  { path: 'crates/pi-coding-agent/docs/deferred-context.md', slug: 'deferred-context', group: 'Use pi', order: 15 },
  { path: 'crates/pi-coding-agent/docs/providers.md', slug: 'providers', group: 'Models and logins', order: 20 },
  { path: 'docs/providers/usage.md', slug: 'usage-limits', group: 'Models and logins', order: 21 },
  { path: 'crates/pi-coding-agent/docs/mcp.md', slug: 'mcp', group: 'Editors and tools', order: 30, title: 'MCP servers' },
  { path: 'crates/pi-coding-agent/docs/acp.md', slug: 'acp', group: 'Editors and tools', order: 31, title: 'ACP mode for Zed and other editors' },
  { path: 'crates/pi-coding-agent/docs/acp-providers.md', slug: 'acp-agents', group: 'Editors and tools', order: 32 },
  { path: 'crates/pi-coding-agent/docs/rpc.md', slug: 'rpc', group: 'Editors and tools', order: 33 },
  { path: 'crates/pi-coding-agent/docs/marketplace.md', slug: 'marketplace', group: 'Extensions', order: 40 },
  { path: 'docs/extensions/native-protocol.md', slug: 'native-extensions', group: 'Extensions', order: 41 },
];

/** README sections that become their own pages. */
const SECTIONS = [
  { heading: 'Quick start', slug: 'quick-start', group: 'Get started', order: 1, title: 'Quick start',
    description: 'The commands to start pi in a project, run one prompt, resume a session, and pick a model.' },
  { heading: 'Configuration', slug: 'configuration', group: 'Get started', order: 3, title: 'Configuration files',
    description: 'pi-rust uses your existing pi folder: logins, settings, models, key bindings, MCP servers, extensions, skills, and sessions.' },
  { heading: 'Differences from upstream pi', slug: 'differences', group: 'Get started', order: 4, title: 'Differences from upstream pi',
    description: 'What pi-rust adds to the TypeScript pi, where its runtime behaves differently, and which upstream bugs it already fixes.' },
  { heading: 'Crates', slug: 'crates', group: 'Reference', order: 50, title: 'Crates',
    description: 'The Rust crates in the pi-rust workspace: pi-ai, pi-agent, pi-tui, pi-mcp, pi-js, pi-coding-agent, and the rest.' },
];

const pageFor = new Map([
  ...FILES.map((f) => [f.path, f.slug === 'install' ? '/install/' : `/docs/${f.slug}/`]),
  ['README.md', '/docs/quick-start/'],
  ['CHANGELOG.md', '/changelog/'],
  ['docs/benchmarks/concurrent-sessions/README.md', '/benchmarks/'],
]);

/** Rewrites relative Markdown links in a file at `from` (a repository path). */
function rewriteLinks(markdown, from) {
  return markdown.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (match, bang, text, href) => {
    if (/^(https?:|mailto:|#)/.test(href)) return match;
    const [path, hash] = href.split('#');
    const target = posix.normalize(posix.join(posix.dirname(from), path));
    const local = pageFor.get(target);
    const url = local
      ? `${local}${hash ? `#${hash}` : ''}`
      : `https://github.com/${REPO}/${bang ? 'raw' : target.includes('.') ? 'blob' : 'tree'}/${tag}/${target}${hash ? `#${hash}` : ''}`;
    return `${bang}[${text}](${url})`;
  });
}

/**
 * The opening prose as plain text for the meta description: paragraphs are joined
 * until there are about 110 characters, then cut at a sentence end near 160.
 */
function summary(markdown) {
  const paragraphs = markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block && !/^(#|```|\||>|<)/.test(block))
    .map((block) =>
      block
        .replace(/^[-*] |^\d+\. /gm, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[`*_]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        // A sentence that introduces a list or code ("To install it:") says nothing on its own.
        .replace(/(^|[.?!] )[^.?!]*:$/, '$1')
        .trim()
    )
    .filter(Boolean);
  let text = '';
  for (const paragraph of paragraphs) {
    text = text ? `${text} ${paragraph}` : paragraph;
    if (text.length >= 110) break;
  }
  if (text.length <= 160) return text;
  const cut = text.slice(0, 161);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.endsWith('.') ? 160 : -1);
  return end > 60 ? cut.slice(0, end + 1).trim() : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

const yaml = (value) => JSON.stringify(value);

function frontmatter(fields) {
  return `---\n${Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${yaml(value)}`)
    .join('\n')}\n---\n\n`;
}

const docsDir = new URL('src/content/docs/', root);
await rm(docsDir, { recursive: true, force: true });
await mkdir(docsDir, { recursive: true });

for (const file of FILES) {
  refs[file.path] = await refFor(file.path);
  const source = await raw(file.path, refs[file.path]);
  const heading = source.match(/^# (.+)$/m)?.[1]?.trim();
  const body = rewriteLinks(source.replace(/^# .+\n+/m, ''), file.path).trim();
  await writeFile(
    new URL(`${file.slug}.md`, docsDir),
    frontmatter({
      title: file.title ?? heading,
      description: summary(body),
      group: file.group,
      order: file.order,
      source: file.path,
      ref: refs[file.path],
      // The description repeats the opening paragraph, so the page does not show it twice.
      lead: false,
    }) + `${body}\n`
  );
}

refs['README.md'] = await refFor('README.md');
const readme = await raw('README.md', refs['README.md']);
for (const section of SECTIONS) {
  const start = readme.indexOf(`\n## ${section.heading}\n`);
  if (start < 0) throw new Error(`README has no "${section.heading}" section`);
  const rest = readme.slice(start + section.heading.length + 5);
  const end = rest.search(/\n## /);
  const body = rewriteLinks((end < 0 ? rest : rest.slice(0, end)).trim(), 'README.md')
    // The section's own subheadings move up one level on a page of their own.
    .replace(/^### /gm, '## ');
  await writeFile(
    new URL(`${section.slug}.md`, docsDir),
    frontmatter({
      title: section.title,
      description: section.description,
      group: section.group,
      order: section.order,
      source: 'README.md',
      ref: refs['README.md'],
      lead: true,
    }) + `${body}\n`
  );
}

// Changelog: one entry per release, newest first.
const changelog = await raw('CHANGELOG.md');
const releases = [...changelog.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})\n([\s\S]*?)(?=^## \[|(?![\s\S]))/gm)].map(
  ([, version, date, body]) => ({ version, date, body: rewriteLinks(body.trim(), 'CHANGELOG.md') })
);

// Benchmark: the report body and its results table as numbers.
const benchmarkPath = 'docs/benchmarks/concurrent-sessions/README.md';
const benchmarkSource = await raw(benchmarkPath);
const benchmark = rewriteLinks(benchmarkSource.replace(/^# .+\n+/m, ''), benchmarkPath).trim();
const tableRows = benchmarkSource
  .split('\n')
  .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
  .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
const [columns, ...rows] = tableRows;
const peak = rows.find((row) => row[0].startsWith('Peak summed RSS'));
const perProcess = rows.find((row) => row[0].startsWith('Individual main-process'));
const elapsed = rows.find((row) => row[0].startsWith('Batch elapsed'));
const harnesses = columns.slice(1).map((name, index) => ({
  name,
  peakMiB: Number(peak[index + 1].replace(/,/g, '')),
  perProcessMiB: perProcess[index + 1],
  elapsedSeconds: Number(elapsed[index + 1]),
}));

/**
 * The daily parity report (the open issue labeled parity-report): the upstream version,
 * the version pi-rust last synced to, and what each section finds missing. When the
 * report can't be read or parsed, the previous numbers stay.
 */
async function parityReport() {
  const [issue] = await api('/issues?labels=parity-report&state=open&per_page=1');
  const body = issue?.body ?? '';
  const upstreamVersion = body.match(/^- Upstream coding-agent version: ([\d.]+)/m)?.[1];
  const synced = body.match(/^- Last sync: .*?version ([\d.]+), on (\d{4}-\d{2}-\d{2})/m);
  const sections = [...body.matchAll(/^\| \d+\. ([^|]+?) \| (\d+) \| (\d+) \| (\d+) \|$/gm)].map((m) => ({
    name: m[1],
    missing: Number(m[2]),
    onlyInPiRust: Number(m[3]),
    allowlisted: Number(m[4]),
  }));
  if (!upstreamVersion || !synced || sections.length < 5) throw new Error('parity report: unexpected format');
  return {
    url: issue.html_url,
    date: issue.updated_at.slice(0, 10),
    upstreamVersion,
    syncedVersion: synced[1],
    syncedDate: synced[2],
    sections,
  };
}

let parity;
try {
  parity = await parityReport();
} catch (error) {
  console.warn(`Keeping the previous parity numbers: ${error.message}`);
  parity = JSON.parse(await readFile(new URL('src/data/upstream.json', root), 'utf8')).parity;
}

await writeFile(
  new URL('src/data/upstream.json', root),
  `${JSON.stringify(
    {
      repo: REPO,
      tag,
      version: tag.replace(/^v/, ''),
      publishedAt: release.published_at,
      releaseUrl: release.html_url,
      stars: repo.stargazers_count,
      license: 'MIT',
      assets: release.assets.map((asset) => ({ name: asset.name, size: asset.size, url: asset.browser_download_url })),
      benchmark: { title: benchmarkSource.match(/^# (.+)$/m)[1], body: benchmark, harnesses },
      parity,
      releases,
      docsRefs: refs,
    },
    null,
    2
  )}\n`
);

// Long-form pages that are not docs: the benchmark report and the changelog.
const pagesDir = new URL('src/content/pages/', root);
await rm(pagesDir, { recursive: true, force: true });
await mkdir(pagesDir, { recursive: true });
await writeFile(
  new URL('benchmarks.md', pagesDir),
  frontmatter({ title: 'Memory with 20 concurrent sessions', source: benchmarkPath }) + `${benchmark}\n`
);
const longDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
await writeFile(
  new URL('changelog.md', pagesDir),
  frontmatter({ title: 'Changelog', source: 'CHANGELOG.md' }) +
    releases.map((r) => `## ${r.version}\n\nReleased ${longDate(r.date)}.\n\n${r.body}\n`).join('\n')
);

const written = await readdir(docsDir);
console.log(`Synced ${written.length} docs pages, ${releases.length} releases, and the benchmark at ${tag}.`);
