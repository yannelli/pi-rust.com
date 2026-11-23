import upstream from '../data/upstream.json';

export const SITE_URL = 'https://pi-rust.com';
export const SITE_NAME = 'pi-rust';
export const REPO_URL = 'https://github.com/yannelli/pi-rust';
export const RELEASES_URL = `${REPO_URL}/releases`;
export const UPSTREAM_PI_URL = 'https://github.com/earendil-works/pi';
/** The daily report that compares pi-rust with upstream pi (a GitHub issue the Parity workflow updates). */
export const PARITY_REPORT_URL = upstream.parity?.url ?? 'https://github.com/yannelli/pi-rust/issues?q=label%3Aparity-report';

/** What pi-rust is, in two sentences: the home page description, the schema, and llms.txt use it. */
export const SUMMARY =
  'A drop-in Rust port of the pi coding agent, built for 1:1 parity. Your pi setup, extensions, skills, and packages work as they are, with no Node.js.';

/** The maintainer. pi-rust.com credits him on every page and links his site. */
export const AUTHOR = {
  name: 'Ryan Yannelli',
  url: 'https://ryanyannelli.com/',
  projectUrl: 'https://ryanyannelli.com/projects/pi-rust/',
  /** The @id of his Person node on ryanyannelli.com, so the two sites describe one person. */
  id: 'https://ryanyannelli.com/#person',
  sameAs: [
    'https://ryanyannelli.com/',
    'https://github.com/yannelli',
    'https://www.linkedin.com/in/ryanyannelli/',
    'https://x.com/RyanYannelli',
  ],
} as const;

/** The author of upstream pi, which pi-rust ports. */
export const UPSTREAM_AUTHOR = { name: 'Mario Zechner' } as const;

export const RELEASE = {
  version: upstream.version,
  tag: upstream.tag,
  date: upstream.publishedAt,
  url: upstream.releaseUrl,
  stars: upstream.stars,
};

export const INSTALL = {
  unix: 'curl -fsSL https://pi-rust.com/install.sh | sh',
  windows: 'irm https://pi-rust.com/install.ps1 | iex',
  brew: 'brew install yannelli/tap/pi',
} as const;

/** 2026-11-21T00:27:30Z → Nov 21, 2026 */
export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
