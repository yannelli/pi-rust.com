import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { readFileSync } from 'node:fs';
import search from './src/integrations/search.ts';
import trailingSlashRedirects from './src/integrations/redirects.ts';

// Every page describes the release in src/data/upstream.json, so its date is each page's lastmod.
const upstream = JSON.parse(readFileSync(new URL('./src/data/upstream.json', import.meta.url), 'utf8'));

export default defineConfig({
  site: 'https://pi-rust.com',
  output: 'static',
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  integrations: [
    sitemap({
      // Account, admin, device, and session viewer pages are noindex and stay out of the sitemap.
      filter: (page) => !page.endsWith('/404/') && !/^https:\/\/pi-rust\.com\/(account|admin|device|session)\//.test(page),
      serialize(item) {
        item.lastmod = upstream.publishedAt;
        return item;
      },
    }),
    search(),
    trailingSlashRedirects(),
  ],
  // Scripts are always files, never inline, so the account pages can send a CSP without 'unsafe-inline'.
  vite: { build: { assetsInlineLimit: (file) => (file.endsWith('.js') ? false : undefined) } },
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
      wrap: false,
    },
  },
});
