import type { APIRoute } from 'astro';
import { docHref, docsNav } from '../lib/docs';
import { FAQ } from '../data/faq';
import { PARITY_DATE, paritySentence, parityRows } from '../lib/parity';
import { AUTHOR, INSTALL, PARITY_REPORT_URL, RELEASE, REPO_URL, SITE_URL, UPSTREAM_PI_URL, formatDate } from '../lib/site';

/** llms.txt (llmstxt.org): what pi-rust is, in a few lines, and where each topic lives. */
export const GET: APIRoute = async () => {
  const nav = await docsNav();
  const lines = [
    '# pi-rust',
    '',
    '> pi-rust is a drop-in Rust port of the pi coding agent by Ryan Yannelli, built for 1:1 parity with upstream pi (the TypeScript original by Mario Zechner) and compared with it every day. It reads an existing ~/.pi/agent setup and runs pi\'s TypeScript extensions, skills, prompt templates, themes, and packages as they are, on a built-in QuickJS engine, so it needs no Node.js. One binary has a streaming LLM API for many providers, an agent loop that calls tools, and the `pi` CLI.',
    '',
    '## Compatibility with pi',
    '',
    '- Drop-in: the same `pi` command. It reads ~/.pi/agent (auth.json, settings.json, models.json, keybindings.json, mcp.json, sessions, extensions, skills, prompts, themes). Session files, settings keys, config paths, and RPC and JSON events match upstream pi byte for byte, so pi and pi-rust can share one setup.',
    '- Extensions: pi TypeScript and JavaScript extensions and `pi install npm:<package>` packages run unchanged on the built-in QuickJS engine with the Node built-in modules. Extensions that need native npm addons can run on Node 22+ (`extensionRuntime: "node"`). Native Rust extensions are an extra option.',
    `- Parity: a daily workflow compares pi-rust with upstream pi. ${[paritySentence, ...parityRows.filter((row) => !row.complete).map((row) => `pi-rust has all but ${row.missing} of pi's ${row.noun}.`)].join(' ')} Report of ${formatDate(PARITY_DATE)}: ${PARITY_REPORT_URL}`,
    `- Every intended difference from upstream pi: ${SITE_URL}/docs/differences/`,
    '',
    `- Latest release: ${RELEASE.tag} (${formatDate(RELEASE.date)})`,
    `- Install on macOS and Linux: \`${INSTALL.unix}\``,
    `- Install on Windows: \`${INSTALL.windows}\``,
    `- Install with Homebrew: \`${INSTALL.brew}\``,
    `- Source code (MIT): ${REPO_URL}`,
    `- Maintainer: ${AUTHOR.name} (${AUTHOR.url}); project page: ${AUTHOR.projectUrl}`,
    `- Upstream pi (TypeScript): ${UPSTREAM_PI_URL}`,
    `- Full text of every page: ${SITE_URL}/llms-full.txt`,
    '',
    ...nav.flatMap(({ name, docs }) => [
      `## ${name}`,
      '',
      ...docs.map((doc) => `- [${doc.data.title}](${SITE_URL}${docHref(doc)}): ${doc.data.description}`),
      '',
    ]),
    '## Questions',
    '',
    ...FAQ.map((item) => `- [${item.question}](${SITE_URL}/faq/#${item.id}): ${item.answer}`),
    '',
    '## Optional',
    '',
    `- [Benchmarks](${SITE_URL}/benchmarks/): memory of 20 concurrent sessions against Node pi and Codex CLI, with method and limits`,
    `- [Changelog](${SITE_URL}/changelog/): every release, newest first`,
    '',
  ];
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
