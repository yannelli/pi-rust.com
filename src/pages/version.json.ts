import type { APIRoute } from 'astro';
import upstream from '../data/upstream.json';

/** The pi-rust release this build of the site describes. The sync workflow compares it with the latest release. */
export const GET: APIRoute = () =>
  new Response(JSON.stringify({ tag: upstream.tag, version: upstream.version, publishedAt: upstream.publishedAt }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
