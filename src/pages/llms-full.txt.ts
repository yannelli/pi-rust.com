import type { APIRoute } from 'astro';
import { getEntry } from 'astro:content';
import { docHref, docsInOrder } from '../lib/docs';
import { FAQ } from '../data/faq';
import { RELEASE, SITE_URL } from '../lib/site';

/** Every docs page, the FAQ, and the benchmark report as one Markdown file, at the synced release. */
export const GET: APIRoute = async () => {
  const docs = await docsInOrder();
  const benchmark = (await getEntry('pages', 'benchmarks'))!;
  const parts = [
    `# pi-rust documentation (${RELEASE.tag})`,
    '',
    'pi-rust is a Rust port of the pi coding agent. This file holds the full text of pi-rust.com. Links point to pi-rust.com or to the pi-rust repository on GitHub.',
    '',
    ...docs.flatMap((doc) => [`---`, '', `# ${doc.data.title}`, '', `Source: ${SITE_URL}${docHref(doc)}`, '', doc.body ?? '', '']),
    '---',
    '',
    '# Frequently asked questions',
    '',
    `Source: ${SITE_URL}/faq/`,
    '',
    ...FAQ.flatMap((item) => [`## ${item.question}`, '', item.answer, '']),
    '---',
    '',
    `# ${benchmark.data.title}`,
    '',
    `Source: ${SITE_URL}/benchmarks/`,
    '',
    benchmark.body ?? '',
    '',
  ];
  return new Response(parts.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
