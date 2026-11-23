// npm run indexnow → submits every URL in the live sitemap to IndexNow (Bing, Yandex, Seznam, Naver, and others)
// npm run indexnow -- <url> ... → submits only those URLs
//
// Run it after a deploy that adds or changes pages. IndexNow checks the key against
// public/indexnow-key.txt on the live site, so that file must be deployed first.
import { readFile } from 'node:fs/promises';
const SITE_URL = 'https://pi-rust.com';

const key = (await readFile(new URL('../public/indexnow-key.txt', import.meta.url), 'utf8')).trim();
const host = new URL(SITE_URL).host;

async function sitemapUrls() {
  const index = await (await fetch(`${SITE_URL}/sitemap-index.xml`)).text();
  const maps = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const urls = [];
  for (const map of maps) {
    const xml = await (await fetch(map)).text();
    urls.push(...[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  }
  return urls;
}

const urlList = process.argv.length > 2 ? process.argv.slice(2) : await sitemapUrls();
const foreign = urlList.filter((url) => new URL(url).host !== host);
if (foreign.length) throw new Error(`IndexNow only takes URLs on ${host}: ${foreign.join(', ')}`);

const response = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host, key, keyLocation: `${SITE_URL}/indexnow-key.txt`, urlList }),
});
// 200 and 202 both mean accepted; 202 means the key is still being verified.
console.log(`IndexNow ${response.status} ${response.statusText} for ${urlList.length} URLs`);
if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}
