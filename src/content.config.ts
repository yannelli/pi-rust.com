import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/** Pages written by scripts/sync.mjs from the pi-rust repository. Do not edit them by hand. */
const docs = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    group: z.string(),
    order: z.number(),
    /** The file in yannelli/pi-rust the page comes from. */
    source: z.string(),
    /** The release tag the file was read at, or main for a docs-only fix made after the release. */
    ref: z.string().optional(),
    /** Show the description under the title. Off when it repeats the opening paragraph. */
    lead: z.boolean().default(false),
  }),
});

/** The benchmark report and the changelog, also written by scripts/sync.mjs. */
const pages = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/pages' }),
  schema: z.object({ title: z.string(), source: z.string() }),
});

export const collections = { docs, pages };
