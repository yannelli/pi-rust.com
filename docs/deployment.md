# Deployment

- [Introduction](#introduction)
- [Deploying](#deploying)
  - [From GitHub Actions](#from-github-actions)
  - [From Your Machine](#from-your-machine)
- [Migrations](#migrations)
- [Cloudflare Resources](#cloudflare-resources)
- [Secrets](#secrets)
- [Setting Up a New Account](#setting-up-a-new-account)

## Introduction

The site runs as the Worker `pi-rust-com` on the custom domain `pi-rust.com`, in the Cloudflare account that holds the zone. `wrangler.jsonc` describes the Worker, its bindings, and its variables.

## Deploying

### From GitHub Actions

Every push to `main` runs `.github/workflows/ci.yml`: it builds the site, runs the Playwright suite, and deploys when the tests pass. Pull requests run the tests only.

The deploy needs the repository secret `CLOUDFLARE_API_TOKEN`. Create it in the Cloudflare dashboard from the **Edit Cloudflare Workers** template, with the account that holds pi-rust.com as its account resource and the `pi-rust.com` zone as its zone resource. The zone permission (Workers Routes) attaches the custom domain; a token with Workers Scripts alone uploads the Worker but fails on the domain.

The `Sync from pi-rust` workflow deploys too, when a new pi-rust release comes out. See [Content and Releases](content.md#release-updates).

### From Your Machine

On a machine logged in with `npx wrangler login`:

```sh
npm run deploy
```

After a deploy that adds or changes pages, run `npm run indexnow` to tell search engines. After a build that adds or renames a page, run `npm run og` and commit `public/og/`.

## Migrations

The D1 schema lives in `migrations/`. Apply a new migration to the live database before you deploy the Worker that needs it:

```sh
npx wrangler d1 migrations apply pi-rust-accounts --remote
```

> [!WARNING]
> `npm run deploy` and the workflows do not apply migrations. Add a new file for each change, and never edit a migration that has been applied.

## Cloudflare Resources

| Resource | Binding | Used by |
| --- | --- | --- |
| D1 database `pi-rust-accounts` | `DB` | [Accounts](accounts.md), [sharing](sharing.md), the [admin area](admin.md), and the bug report list |
| R2 bucket `pi-rust-shares` | `SHARES` | [Session sharing](sharing.md) |
| R2 bucket `pi-rust-bug-reports` | `BUG_REPORTS` | [Bug reports](bug-reports.md) |
| Email sending from `accounts@pi-rust.com` | `EMAIL` | Account email |
| Email sending from `bugs@pi-rust.com` | `BUG_EMAIL` | Bug report email |
| Analytics Engine dataset `pi_rust_install_telemetry` | `INSTALL_TELEMETRY` | [Install telemetry](install-telemetry.md) |
| Rate limit, namespace `4101`, 5 per 60 s | `BUG_REPORT_LIMITER` | Bug reports |
| Rate limit, namespace `4102`, 10 per 60 s | `INSTALL_TELEMETRY_LIMITER` | Install telemetry |
| Rate limit, namespace `4103`, 10 per 60 s | `AUTH_LIMITER` | Sign-in and the other account routes |
| Rate limit, namespace `4104`, 10 per 60 s | `SHARE_LIMITER` | Share uploads |
| Cron trigger `17 * * * *` | | The hourly cleanup (`worker/cleanup.ts`) |
| Static assets in `dist/` | `ASSETS` | Every page |

The variables in `wrangler.jsonc` are `BUG_REPORT_FROM`, `ACCOUNT_EMAIL_FROM`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_ZONE_ID`.

## Secrets

Set each secret with `npx wrangler secret put <NAME>`. None of them belong in the repository.

| Secret | Value |
| --- | --- |
| `AUTH_PEPPER` | Any long random string. Mixed into password and recovery code hashes |
| `TOTP_ENCRYPTION_KEY` | Base64 of 32 random bytes. Encrypts two-step verification secrets |
| `BUG_REPORT_TO` | The address that receives bug reports. It must be a verified Email Routing destination |
| `CLOUDFLARE_ANALYTICS_TOKEN` | Optional. An API token for the admin area's analytics; see [Admin Area](admin.md#analytics-token) |

> [!WARNING]
> Never change `AUTH_PEPPER` or `TOTP_ENCRYPTION_KEY` on a live site. A new pepper breaks every password and recovery code, and a new key breaks every two-step verification secret.

Without `AUTH_PEPPER`, the account API answers `503 not_configured`. Without `TOTP_ENCRYPTION_KEY`, so does two-step verification. Without `BUG_REPORT_TO`, bug reports are stored but not emailed.

## Setting Up a New Account

To run the site in another Cloudflare account, create the resources, put the new IDs in `wrangler.jsonc`, and set the secrets:

```sh
npx wrangler d1 create pi-rust-accounts               # put the printed database_id in wrangler.jsonc
npx wrangler d1 migrations apply pi-rust-accounts --remote
npx wrangler r2 bucket create pi-rust-shares
npx wrangler r2 bucket create pi-rust-bug-reports
npx wrangler r2 bucket lifecycle add pi-rust-bug-reports expire-bug-reports bug-reports/ --expire-days 90 --force
openssl rand -base64 32 | npx wrangler secret put AUTH_PEPPER
openssl rand -base64 32 | npx wrangler secret put TOTP_ENCRYPTION_KEY
npx wrangler secret put BUG_REPORT_TO
```

Then, in the Cloudflare dashboard:

1. Turn on Email Routing for the zone, and verify the `BUG_REPORT_TO` address as a destination.
2. Onboard the zone to Email Sending (Email, then Email Sending). It adds the return path, DKIM, and DMARC records. Without it, account email reaches only verified Email Routing addresses, and other sends fail with `E_RECIPIENT_NOT_ALLOWED`.

The first write creates the Analytics Engine dataset. To make the first admin, see [Admin Area](admin.md#making-the-first-admin).
