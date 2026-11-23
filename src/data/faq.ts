import upstream from './upstream.json';
import { paritySentence } from '../lib/parity';
import { PARITY_REPORT_URL } from '../lib/site';

/**
 * Questions people ask about pi-rust. Each answer opens with the direct answer,
 * so search and answer engines can quote it alone, and stays short. Facts come
 * from the README and docs at the synced release; `links` follow the answer.
 */
const [rust, node, codex] = upstream.benchmark.harnesses;
const mib = (value: number) => Math.round(value).toLocaleString('en-US');

export const FAQ: { id: string; question: string; answer: string; links?: { label: string; href: string }[] }[] = [
  {
    id: 'what-is-pi-rust',
    question: 'What is pi-rust?',
    answer:
      'pi-rust is a drop-in Rust port of the pi coding agent by Ryan Yannelli, built for 1:1 parity with pi. One binary has a streaming API for models from many providers, an agent loop that calls tools, and the pi command line.',
    links: [{ label: 'Quick start', href: '/docs/quick-start/' }],
  },
  {
    id: 'drop-in',
    question: 'Is pi-rust a drop-in replacement for pi?',
    answer:
      "Yes. It's the same pi command, and it reads ~/.pi/agent: your logins, settings, models, key bindings, MCP servers, sessions, extensions, and skills. Session files and RPC events match pi byte for byte, so you can switch between the two. Set PI_CODING_AGENT_DIR to use another folder.",
    links: [{ label: 'Configuration files', href: '/docs/configuration/' }],
  },
  {
    id: 'parity',
    question: 'Does pi-rust have full parity with pi?',
    answer: [
      'pi-rust is a 1:1 port, and a workflow compares it with upstream pi every day.',
      paritySentence,
      'Session files, settings, config paths, and RPC and JSON events match pi byte for byte.',
    ]
      .filter(Boolean)
      .join(' '),
    links: [{ label: 'Latest parity report', href: PARITY_REPORT_URL }],
  },
  {
    id: 'extensions',
    question: 'Do pi extensions work in pi-rust?',
    answer:
      'Yes. TypeScript extensions, skills, prompt templates, themes, and pi packages work as they are. Extensions run on a built-in QuickJS engine with the Node built-in modules. Extensions that need native npm addons run on Node 22 or later when extensionRuntime is "node". pi-rust also runs native extensions written in Rust.',
    links: [
      { label: 'Extension runtime', href: '/docs/cli/#extension-runtime' },
      { label: 'Native extensions', href: '/docs/marketplace/' },
    ],
  },
  {
    id: 'difference-from-pi',
    question: 'How is pi-rust different from pi?',
    answer:
      'pi-rust has everything in pi, runs without Node.js, and adds /diff, /review, /undo, /retry, pi doctor, run limits, structured output, ACP mode, subscription usage limits, and native extensions.',
    links: [{ label: 'Differences from upstream pi', href: '/docs/differences/' }],
  },
  {
    id: 'node',
    question: 'Does pi-rust need Node.js?',
    answer:
      'No. pi-rust is one binary, and extensions run on its built-in QuickJS engine. To run them on Node 22 or later instead, set extensionRuntime to "node".',
    links: [{ label: 'Extension runtime', href: '/docs/cli/#extension-runtime' }],
  },
  {
    id: 'install',
    question: 'How do I install pi-rust?',
    answer:
      'On macOS and Linux, run curl -fsSL https://pi-rust.com/install.sh | sh. On Windows, run irm https://pi-rust.com/install.ps1 | iex. With Homebrew, run brew install yannelli/tap/pi.',
    links: [{ label: 'Install pi-rust', href: '/install/' }],
  },
  {
    id: 'platforms',
    question: 'Which operating systems does pi-rust support?',
    answer: 'macOS on Apple silicon and Intel, Linux on x86-64, arm64, and armv7, and Windows on x86-64 and arm64.',
    links: [{ label: 'Downloads', href: '/install/#downloads' }],
  },
  {
    id: 'providers',
    question: 'Which models and providers does pi-rust support?',
    answer:
      'Every provider pi supports, including Anthropic, OpenAI, Google, Amazon Bedrock, Mistral, xAI, GitHub Copilot, and OpenRouter, plus Cursor and Google Antigravity subscriptions. Log in with /login or an API key.',
    links: [{ label: 'Providers and logins', href: '/docs/providers/' }],
  },
  {
    id: 'editors',
    question: 'Does pi-rust work in Zed or other editors?',
    answer: 'Yes. pi --mode acp runs pi as an agent inside Zed and other ACP editors, with no adapter.',
    links: [{ label: 'ACP mode', href: '/docs/acp/' }],
  },
  {
    id: 'mcp',
    question: 'Does pi-rust support MCP servers?',
    answer: 'Yes, over stdio and HTTP with OAuth. Add servers to ~/.pi/agent/mcp.json or a project\'s .pi/mcp.json.',
    links: [{ label: 'MCP servers', href: '/docs/mcp/' }],
  },
  {
    id: 'memory',
    question: 'How much memory does pi-rust use?',
    answer: `About ${Math.round(Number(rust.perProcessMiB.split('–')[1]))} MiB per session. With 20 sessions at once on a 16 GB Mac, pi-rust peaked at ${mib(rust.peakMiB)} MiB in total, against ${mib(node.peakMiB)} MiB for Node pi and ${mib(codex.peakMiB)} MiB for Codex CLI.`,
    links: [{ label: 'How it was measured', href: '/benchmarks/' }],
  },
  {
    id: 'update',
    question: 'How do I update pi-rust?',
    answer: 'Run pi update --self. If you installed with Homebrew, run brew upgrade yannelli/tap/pi.',
    links: [{ label: 'Changelog', href: '/changelog/' }],
  },
  {
    id: 'license',
    question: 'Is pi-rust free and open source?',
    answer: 'Yes. pi-rust is MIT licensed, and the source is on GitHub at yannelli/pi-rust.',
    links: [{ label: 'Source on GitHub', href: 'https://github.com/yannelli/pi-rust' }],
  },
  {
    id: 'maintainer',
    question: 'Who makes pi-rust?',
    answer: 'Ryan Yannelli, a software engineer in New York.',
    links: [{ label: 'Ryan Yannelli on pi-rust', href: 'https://ryanyannelli.com/projects/pi-rust/' }],
  },
  {
    id: 'official',
    question: 'Is pi-rust.com the website of upstream pi?',
    answer:
      'No. pi-rust.com is the website of pi-rust. Upstream pi is the TypeScript original by Mario Zechner, at github.com/earendil-works/pi.',
    links: [{ label: 'Upstream pi on GitHub', href: 'https://github.com/earendil-works/pi' }],
  },
];
