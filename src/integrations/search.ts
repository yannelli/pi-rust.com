/**
 * Builds the Pagefind index after Astro writes dist/. Pages opt in with
 * `data-pagefind-body`; navigation, footers, and code chrome opt out.
 */
import type { AstroIntegration } from 'astro';
import { fileURLToPath } from 'node:url';
import * as pagefind from 'pagefind';

export default function search(): AstroIntegration {
  return {
    name: 'pagefind-search',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const out = fileURLToPath(dir);
        const { index, errors } = await pagefind.createIndex({ excludeSelectors: ['nav', '.copy', '[data-pagefind-ignore]'] });
        if (!index) throw new Error(`Pagefind: ${errors.join(', ')}`);
        const { page_count } = await index.addDirectory({ path: out });
        await index.writeFiles({ outputPath: `${out}/pagefind` });
        await pagefind.close();
        logger.info(`Indexed ${page_count} pages for search.`);
      },
    },
  };
}
