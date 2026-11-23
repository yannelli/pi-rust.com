/**
 * Writes a permanent redirect from each page's bare path to its trailing-slash
 * URL (`/install` → `/install/`) into dist/_redirects. Without these rules the
 * Cloudflare asset layer answers the bare path with a temporary 307.
 */
import type { AstroIntegration } from 'astro';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export default function trailingSlashRedirects(): AstroIntegration {
  return {
    name: 'trailing-slash-redirects',
    hooks: {
      'astro:build:done': async ({ dir, pages, logger }) => {
        const rules = pages
          .map((page) => page.pathname)
          .filter((path) => path.endsWith('/') && path !== '/')
          .map((path) => `/${path.replace(/^\/|\/$/g, '')}`)
          .sort()
          .map((bare) => `${bare} ${bare}/ 301`);
        await appendFile(fileURLToPath(new URL('_redirects', dir)), `${rules.join('\n')}\n`);
        logger.info(`Added ${rules.length} trailing-slash redirects.`);
      },
    },
  };
}
