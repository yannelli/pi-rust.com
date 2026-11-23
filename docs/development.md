# Local Development

- [Introduction](#introduction)
- [Installation](#installation)
- [Running the Site](#running-the-site)
  - [Pages Only](#pages-only)
  - [With the Worker](#with-the-worker)
- [Local Accounts](#local-accounts)
  - [The Dev Mailbox](#the-dev-mailbox)
  - [Test Routes](#test-routes)
- [Testing](#testing)
- [Commands](#commands)
- [Paseo](#paseo)

## Introduction

pi-rust.com is a static [Astro](https://astro.build) site served by a Cloudflare Worker. The pages build into `dist/`. The Worker (`worker/index.ts`) serves them and answers every dynamic route: the install scripts, accounts and sharing, the admin area, and the endpoints the pi CLI calls.

## Installation

The site needs Node.js 22 or later (`.nvmrc`):

```sh
npm install
```

The synced docs, changelog, and release data are committed, so the site builds without network access. To pull the latest release from [yannelli/pi-rust](https://github.com/yannelli/pi-rust), run `npm run sync`. Set `GITHUB_TOKEN` to avoid GitHub's rate limit for anonymous requests. See [Content and Releases](content.md).

## Running the Site

### Pages Only

The Astro dev server reloads pages and styles as you edit them:

```sh
npm run dev   # http://localhost:4321
```

It serves the pages only. The Worker's routes, such as `/install.sh`, `/account/`, and every API, need `wrangler dev`.

### With the Worker

Build the site, create the local database, and start the Worker:

```sh
npm run build
npx wrangler d1 migrations apply pi-rust-accounts --local
npx wrangler dev --infer-origin-from-routes=false --var DEV_MAILBOX:1 --var AUTH_PEPPER:dev --var TOTP_ENCRYPTION_KEY:$(openssl rand -base64 32)
```

You may put the three variables in a `.dev.vars` file instead, which git ignores. `wrangler dev` runs the D1, R2, rate limit, and Analytics Engine bindings locally, so local data never reaches the live site.

`--infer-origin-from-routes=false` keeps requests on `localhost`. Without it, `wrangler dev` rewrites them to `https://pi-rust.com`, and the account API's origin check and the dev mailbox stop working.

> [!NOTE]
> Open the site at `http://localhost:<port>`, not `127.0.0.1`. Passkeys need a host name.

## Local Accounts

### The Dev Mailbox

With `DEV_MAILBOX=1`, a request to `localhost` or `127.0.0.1` does not send email. The Worker writes each message to the `dev_mailbox` table instead, so you can sign up and follow verification and reset links locally. `DEV_MAILBOX` must never be set in `wrangler.jsonc`.

### Test Routes

With the dev mailbox on, the Worker also answers these routes (`worker/accounts/dev.ts`). Everywhere else they are `404`.

| Route | What it does |
| --- | --- |
| `GET /__dev/mailbox?to=<email>` | Lists the messages for one address, newest first |
| `POST /__dev/state` | Moves a row to a state a test cannot wait for (see below) |
| `POST /__dev/cleanup` | Runs the hourly cleanup, optionally as of `{"now": <Unix ms>}`, and returns what it deleted |

`/__dev/state` takes one of these actions:

| Action | Effect |
| --- | --- |
| `{"action": "make-admin", "email"}` | Makes the account an admin |
| `{"action": "unverify", "email"}` | Marks the address as not verified |
| `{"action": "age-reauth", "email"}` | Makes the last password or passkey confirmation 11 minutes old |
| `{"action": "expire-share", "id"}` | Expires a share |
| `{"action": "expire-device-code", "userCode"}` | Expires a pi CLI sign-in request |
| `{"action": "expire-email-tokens", "email"}` | Expires the account's verify and reset links |
| `{"action": "unindex-bug-report", "id"}` | Deletes a bug report's row, so the cleanup indexes it again |

The `expire-` actions take an optional `at` (Unix ms) for the new expiry. The default is a second ago.

To become an admin locally, sign up, open the verification link from the mailbox, turn on two-step verification at `/account/security/`, and post `make-admin` with your address.

## Testing

The tests use [Playwright](https://playwright.dev) against `wrangler dev`, in a desktop and a phone browser:

```sh
npx playwright install chromium   # once
npm run build
npm test
```

`playwright.config.ts` applies the local migrations and starts `wrangler dev` on port 4411 with test-only values for the account variables. Set `PORT` to use another port.

Each test client sends its own `CF-Connecting-IP`, because the local rate limiters keep their counts for a minute. Running the whole suite twice within a minute can still trip the bug report limiter (5 a minute); wait a minute and run it again.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Astro dev server at `http://localhost:4321` |
| `npm run sync` | Pulls docs, changelog, benchmark, and release data from yannelli/pi-rust |
| `npm run build` | Type-checks (`astro check`), then builds `dist/` with the search index and redirects |
| `npm run og` | After a build: renders a social card for every page into `public/og/` |
| `npm test` | Playwright against `wrangler dev` |
| `npm run deploy` | Builds, then deploys with `wrangler deploy` |
| `npm run indexnow` | After a deploy: submits the live sitemap to IndexNow |

`npm run og` drives Google Chrome. Set `CHROME_BIN` when it is not at `google-chrome`.

## Paseo

`paseo.json` sets up each new [Paseo](https://paseo.sh) worktree with `npm ci` and Playwright's Chromium, and defines these scripts:

| Script | What it runs |
| --- | --- |
| `site` | Service: the built site and the Worker under `wrangler dev`, with the local migrations and the test values |
| `docs` | Service: the Astro dev server |
| `build`, `test`, `og` | The npm scripts of the same names; `test` uses the worktree's own port |

Open the account and admin pages of `site` at `http://localhost:<port>`, not at its proxy URL: the account API accepts only the site's own origin. `.worktreeinclude` copies a local `.dev.vars` or `.env` into new worktrees.
