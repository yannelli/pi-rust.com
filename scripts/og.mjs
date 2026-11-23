// npm run og → renders a 1200×630 social card for every built page into public/og/ (and dist/og/).
// Run it after `astro build`: it reads each page's og:image path, title, and description from
// dist/, and draws the pi-rust mark from the built home page, so cards always match the pages.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const chrome = process.env.CHROME_BIN || 'google-chrome';
const font = await readFile(join(root, 'node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2'));
const home = await readFile(join(dist, 'index.html'), 'utf8');
const mark = home.match(/<svg viewBox="-20[\s\S]*?<\/svg>/)?.[0].replace(/<title[^>]*>.*?<\/title>/, '');
if (!mark) throw new Error('Build the site first: dist/index.html has no mark.');

const decode = (value) => value.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const meta = (html, property) => {
  const found = html.match(new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`));
  return found ? decode(found[1]) : undefined;
};

async function pages(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !['_astro', 'pagefind', 'og'].includes(entry.name)) out.push(...(await pages(path)));
    else if (entry.name === 'index.html') out.push(path);
  }
  return out;
}

function card({ title, description, eyebrow }) {
  const size = title.length > 34 ? 64 : 80;
  return `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Geist;src:url(data:font/woff2;base64,${font.toString('base64')});font-weight:100 900}
*{margin:0;box-sizing:border-box}
html,body{width:1200px;height:630px;overflow:hidden}
body{background:#fafafa;color:#171717;font-family:Geist,sans-serif;padding:64px 72px;display:grid;grid-template-columns:1fr 330px;gap:40px}
.copy{display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:12px;font-size:26px;font-weight:600;letter-spacing:-.02em}
.brand svg{width:30px;height:30px}
.eyebrow{margin-top:auto;font-size:24px;color:#6b6b6b;font-weight:500}
h1{margin-top:14px;font-size:${size}px;line-height:1.02;font-weight:600;letter-spacing:-.045em;text-wrap:balance}
p{margin-top:22px;font-size:26px;line-height:1.4;color:#4d4d4d;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.url{margin-top:auto;padding-top:28px;font-size:22px;color:#6b6b6b}
.mark{align-self:center;color:#171717}
.mark svg{width:330px;height:auto;overflow:visible}
</style><body><div class="copy">
<div class="brand"><svg viewBox="165 165 470 470"><path fill="#DE5E28" d="M165.29 165.29H517.36V400H400V282.65H165.29Z"/><path fill="#A33B1A" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"/><path fill="#E6984F" d="M517.36 400H634.72V634.72H517.36Z"/></svg>pi-rust</div>
<div class="eyebrow">${escape(eyebrow)}</div><h1>${escape(title)}</h1><p>${escape(description)}</p><div class="url">pi-rust.com</div>
</div><div class="mark">${mark}</div></body>`;
}

const temp = await mkdtemp(join(tmpdir(), 'pi-rust-og-'));
await mkdir(join(root, 'public/og'), { recursive: true });
await mkdir(join(dist, 'og'), { recursive: true });
const done = new Set();
try {
  for (const file of await pages(dist)) {
    const html = await readFile(file, 'utf8');
    const image = meta(html, 'og:image');
    if (!image || !image.includes('/og/') || /noindex/.test(meta(html, 'robots') ?? '')) continue;
    const name = image.split('/og/')[1];
    if (done.has(name)) continue;
    done.add(name);
    const path = '/' + file.slice(dist.length + 1).replace(/index\.html$/, '');
    const eyebrow = path === '/' ? 'Open source coding agent' : path.startsWith('/docs/') ? 'Docs' : path.replace(/\//g, '') ? 'pi-rust' : '';
    // The shared title ends in " | pi-rust"; the card already shows the name.
    const title = path === '/' ? 'The pi coding agent, ported 1:1 to Rust.' : (meta(html, 'og:title') ?? 'pi-rust').replace(/ \| pi-rust$/, '');
    const page = join(temp, 'card.html');
    await writeFile(page, card({ title, description: meta(html, 'og:description') ?? '', eyebrow }));
    execFileSync(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
      '--window-size=1200,630', `--user-data-dir=${join(temp, 'chrome')}`, `--screenshot=${join(temp, 'card.png')}`, pathToFileURL(page).href],
      { stdio: 'pipe', timeout: 30000 });
    const out = join(root, 'public/og', name);
    await sharp(join(temp, 'card.png')).resize(1200, 630, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(out);
    await copyFile(out, join(dist, 'og', name));
  }
  console.log(`Rendered ${done.size} social cards.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
