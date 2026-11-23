# Content and Releases

- [Introduction](#introduction)
- [Synced Content](#synced-content)
  - [Docs Fixes Between Releases](#docs-fixes-between-releases)
  - [Links](#links)
- [Hand-Written Copy](#hand-written-copy)
- [Release Updates](#release-updates)

## Introduction

The site states nothing that the [pi-rust repository](https://github.com/yannelli/pi-rust) does not. Every docs page, the changelog, the benchmark report, and the release numbers come from that repository at its latest release tag. A new release reaches the site without anyone editing it here.

## Synced Content

`npm run sync` (`scripts/sync.mjs`) reads the latest release of yannelli/pi-rust and writes:

| Output | From |
| --- | --- |
| `src/content/docs/*.md` | `crates/pi-coding-agent/docs/*.md`, `docs/providers/usage.md`, `docs/extensions/native-protocol.md`, and four README sections |
| `src/content/pages/changelog.md` | `CHANGELOG.md` |
| `src/content/pages/benchmarks.md` | `docs/benchmarks/concurrent-sessions/README.md` |
| `src/data/upstream.json` | The release (tag, date, assets), the star count, and the benchmark table as numbers |

> [!WARNING]
> Never edit `src/content/` or `src/data/upstream.json` by hand; the next sync overwrites them. Fix a wrong doc in yannelli/pi-rust, then sync.

### Docs Fixes Between Releases

Each doc is read at the release tag. When every commit that touched a doc since the release is a `docs:` commit, the sync reads that doc from `main` instead. A wording fix then reaches the site without a new release, while a doc changed by an unreleased feature stays at the tag.

### Links

Relative links in the synced files are rewritten. A link to a synced page goes to its page on pi-rust.com, and any other link goes to the file on GitHub at the release tag.

## Hand-Written Copy

Three places hold copy written for the site: the home page (`src/pages/index.astro`), the install page intro (`src/pages/install.astro`), and the FAQ (`src/data/faq.ts`). They state only what the synced docs say, and their numbers come from `src/data/upstream.json`. Check a claim against the synced docs before you change it.

## Release Updates

The `Sync from pi-rust` workflow (`.github/workflows/sync.yml`) keeps the live site on the latest release. It runs every hour on GitHub Actions:

1. It syncs from yannelli/pi-rust.
2. When the synced content changed, or `/version.json` on the live site reports an older release, it builds, renders the social cards, and runs the tests.
3. It commits the new content to `main` as `chore(content): sync pi-rust <tag>`.
4. It deploys, and submits the sitemap to IndexNow.

A failed step stops the run, so a build that fails its tests never deploys. To run it now, open the workflow in the repository's Actions tab and select **Run workflow**. Check **force** to build, test, and deploy even when nothing changed.
