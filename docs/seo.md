# Search and Indexing

- [Introduction](#introduction)
- [Structured Data](#structured-data)
- [Crawlers](#crawlers)
- [Pages Kept Out of Search](#pages-kept-out-of-search)
- [URLs and Sitemaps](#urls-and-sitemaps)
- [Social Cards](#social-cards)

## Introduction

pi-rust.com is documentation for an open-source tool, so search engines and AI assistants may crawl, index, and cite every public page. The exceptions are shared sessions and the signed-in pages.

## Structured Data

Each page has one JSON-LD graph (`src/lib/seo.ts`):

| Page | Nodes |
| --- | --- |
| Every page | `WebSite`, and the maintainer's `Person` with the same `@id` as on ryanyannelli.com (`https://ryanyannelli.com/#person`) |
| Home page | `SoftwareApplication` and `SoftwareSourceCode` |
| Docs pages | `TechArticle` and `BreadcrumbList` |
| FAQ | `FAQPage` |

`/llms.txt` and `/llms-full.txt` are generated from the docs at build time.

## Crawlers

`public/robots.txt` allows every crawler. AI crawlers it names (GPTBot, ClaudeBot, PerplexityBot, CCBot, and others) are asked to skip shared sessions with `Disallow: /s/` and `Disallow: /session/`. Search engines may fetch those paths, because a crawler that may not fetch a page never sees its `noindex`.

## Pages Kept Out of Search

- **Shared sessions** (`/s/` and `/session/`) are never indexed. See [Session Sharing](sharing.md#indexing).
- **Account, device, and admin pages** are `noindex`, and are left out of the sitemap and the site search.

## URLs and Sitemaps

Every public page has a canonical URL with a trailing slash. Bare paths such as `/install` answer `301` to `/install/`; the build writes these rules into `dist/_redirects`. The sitemap is `/sitemap-index.xml`.

After a deploy that adds or changes pages, `npm run indexnow` submits the live sitemap to IndexNow. IndexNow checks the key in `public/indexnow-key.txt` on the live site.

## Social Cards

Every page has a 1200×630 social card in `public/og/` and `max-image-preview:large`. After a build that adds or renames a page, run `npm run og` and commit `public/og/`.
