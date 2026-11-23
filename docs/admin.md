# Admin Area

- [Introduction](#introduction)
- [Access](#access)
  - [Making the First Admin](#making-the-first-admin)
- [Pages](#pages)
- [Actions](#actions)
- [Privacy](#privacy)
- [Analytics](#analytics)
  - [Analytics Token](#analytics-token)
  - [Install Stats](#install-stats)
  - [Users and Versions](#users-and-versions)
- [Bug Report List](#bug-report-list)
- [API](#api)
- [Data Model](#data-model)
- [Cloudflare API Notes](#cloudflare-api-notes)

## Introduction

`https://pi-rust.com/admin/` is where admins see stats and moderate accounts, shares, and bug reports. The Worker code is in `worker/admin/`; the pages are in `src/pages/admin/`, with their layout in `src/layouts/Admin.astro`, their scripts in `src/scripts/admin/`, and their styles in `src/styles/admin.css`.

## Access

An account opens the admin area when its `role` is `admin` and it has two-step verification (TOTP) or a passkey, so a stolen password alone never opens it.

- A signed-out visitor of `/admin/` goes to sign-in.
- Anyone signed in who is not an admin gets the site's 404 page, so the admin pages do not show that they exist.
- An admin without a second step gets the page, which links to `/account/security/` to turn one on. The admin API answers `403 two_step_required`.

Admins see an "Admin" link in the account pages' navigation.

### Making the First Admin

Give your account the role on a machine logged in with `npx wrangler login`:

```sh
npx wrangler d1 execute pi-rust-accounts --remote --command "UPDATE users SET role = 'admin' WHERE email = '<your address>'"
```

Then turn on two-step verification or add a passkey at `/account/security/`, and open `/admin/`. From then on, admins make other admins on the People page. An account needs a verified address to become an admin. If no admin can sign in, the same command sets or removes the role.

## Pages

| Page | What it shows |
| --- | --- |
| `/admin/` | Totals for accounts, shares, open bug reports, and installs; pi-rust users per day and their versions and platforms; new accounts and shares per day; and install stats |
| `/admin/people/` | Every account, newest first, with search by address and filters for admins, suspended, and unverified accounts |
| `/admin/shares/` | Every share and its owner, with search by title, owner, or share ID, and filters by visibility and expiry |
| `/admin/bug-reports/` | `/bug` reports, newest first, with search and an open or closed filter. A report opens with its description, environment, files, and JSON parts (up to 512 KB each). `/admin/bug-reports/#<id>` opens one report; each report email links there |
| `/admin/activity/` | What admins did, newest first |

Lists load 50 rows at a time. The search and filter are kept in the address, so a reload or a shared link shows the same list.

## Actions

Actions that are hard to undo need the account pages' [confirmation](accounts.md#confirming-its-you) from the last 10 minutes.

| Action | Confirmation | Effect |
| --- | --- | --- |
| Make admin, remove admin access | Yes | Sets the role. Not for a suspended or unverified account |
| Sign out everywhere | Yes | Deletes every session, CLI token, pending sign-in, and device code of the account |
| Suspend | Yes | Signs out everywhere and blocks sign-in. The account's shares answer `404`. An optional reason goes to the activity log |
| Restore | Yes | Lifts the suspension. The account signs in and its shares open again |
| Delete account | Yes | The same deletion as the account's own, with the "account deleted" email. The address can sign up again; suspend to stop that |
| Make a share private | No | Only the owner can open it from then on. The owner can change it back |
| Delete a share | Yes | Deletes the HTML, then the row |
| Close or reopen a report | No | Sets the report's status |
| Delete a report | Yes | Deletes the report's files, then the row. An email copy stays in the inbox |

An admin cannot act on their own account here (`409 own_account`), and must remove another admin's access before suspending or deleting that account (`409 is_admin`). Every change is written to the activity log, which keeps entries for a year.

## Privacy

Admins cannot see:

- **A private share's content.** They see its title, owner, size, dates, and view count, and can delete it. `/s/<id>` is a `404` to them, as to anyone but the owner.
- **Secrets.** D1 holds passwords, TOTP secrets, recovery codes, and tokens only as hashes or ciphertext.
- **IP addresses.** Nothing stores one. The user count keeps a daily salted hash, and the Worker never asks Cloudflare for an address.

Opening a share as an admin does not count as a view.

## Analytics

### Analytics Token

Install stats and the catalog request total come from Cloudflare's analytics APIs, which need an API token. Both are optional; the user count works without them. Create one token with two permissions:

- **Account Analytics Read**, for the account that holds pi-rust.com.
- **Analytics Read** (a zone permission), for the `pi-rust.com` zone.

Then store it as the Worker secret:

```sh
npx wrangler secret put CLOUDFLARE_ANALYTICS_TOKEN
```

The account and zone IDs are the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_ZONE_ID` variables in `wrangler.jsonc`. Without the secret, the overview says that install stats are not set up and leaves out the request total.

### Install Stats

Install and update pings are in Analytics Engine; only users who turn telemetry on send them (see [Install Telemetry](install-telemetry.md)). The overview asks the SQL API for the last 30 days: pings per day, the 10 most common versions, and the 10 most common platform and architecture pairs.

### Users and Versions

pi-rust 0.12.27 and later read the [model catalog](model-catalog.md) from pi-rust.com, whether or not telemetry is on, with `User-Agent: pi/<version> (<platform>; rust; <arch>)`. The Worker counts each client once a day from these requests (`worker/catalog-clients.ts`), without storing its IP address:

1. After the response to a `GET` of `/api/models/providers/<id>` with a `pi/` or `pi-rust/` User-Agent, the Worker takes the HMAC-SHA256 of `<ip>\n<platform>\n<arch>`, keyed with the salt of the UTC day, and keeps 32 hex characters. The version is left out, so a client that updates during the day is still one client.
2. The first request of a day makes that day's salt (32 random bytes) in `catalog_salts`. The hourly cleanup deletes each salt once its day is over, so a day's hashes cannot be traced back to an address or linked to another day.
3. `catalog_clients` gets one row per day, client, and version. The cleanup deletes rows after 90 days.

The overview shows users today, the average users per day over the full days since counting began, the share of today's users on the latest release, users per day for 30 days, and each version's and platform's share of daily users. With the analytics token, it also shows the catalog requests of the last 30 days, as Cloudflare estimates them.

A user is one IP address, platform, and architecture on one UTC day. People behind one address on the same platform, such as an office, count once; one person on two networks counts twice. A client with `PI_CATALOG_URL` set to another server does not count.

Counting began on 2026-11-23. The hours of that day before the first deploy were filled in once from Cloudflare's request analytics, with the same hash and that day's salt; no address was stored.

## Bug Report List

The admin area lists [bug reports](bug-reports.md) from the `bug_reports` table; the files stay in R2. The upload writes the row after it stores the files, and a failed row write still lets the upload succeed. The hourly cleanup adds a row for each report in R2 that has none, up to 50 a run, and deletes rows after 90 days, when the bucket deletes the files.

## API

Every endpoint is under `/api/admin/`, needs a signed-in admin with a second step, and follows the account API's [rules](accounts.md#security) for CSRF and headers.

| Request | Answer |
| --- | --- |
| `GET overview` | Totals for `accounts`, `shares`, `cliTokens`, and `bugReports`, and `days`: 30 of `{date, signUps, shares}` |
| `GET installs` | `{configured: false}`, `{configured: true, error}`, or `{configured: true, total, versions, platforms, days}` |
| `GET versions` | `users: {today, since, days, versions, platforms, todayVersions}`, and `requests`: `{configured: false}`, `{configured: true, error}`, or `{configured: true, total}` |
| `GET activity?offset=` | `events`, `next` |
| `GET users?q=&filter=all\|admins\|suspended\|unverified&offset=` | `users`, `total`, `next` |
| `POST users/<id>/role` with `{"role": "admin" \| "user"}` | `{role}` |
| `POST users/<id>/suspend` with an optional `{"reason"}` (500 characters) | `{}` |
| `POST users/<id>/restore`, `users/<id>/sign-out`, `users/<id>/delete` | `{}` |
| `GET shares?q=&filter=all\|link\|private\|expired&offset=` | `shares` (with `owner`, and a `url` only when anyone with the link can open it), `total`, `next` |
| `POST shares/<id>/hide` | `{}` |
| `DELETE shares/<id>` | `{}` |
| `GET bug-reports?q=&status=open\|closed\|all&offset=` | `reports`, `total`, `next` |
| `GET bug-reports/<id>` | `report`, `reportJson`, `diagnostics` (null when missing or over 512 KB) |
| `GET bug-reports/<id>/files/<part>` | The file, as a download |
| `PATCH bug-reports/<id>` with `{"status": "open" \| "closed"}` | `{status}` |
| `DELETE bug-reports/<id>` | `{}` |

Errors: `400 invalid_request`, `401 unauthorized`, `403 forbidden` (not an admin), `403 two_step_required`, `403 reauth_required`, `404 not_found`, `409 own_account`, `409 is_admin`, `409 suspended`, `409 email_not_verified`.

## Data Model

| Table or column | Holds |
| --- | --- |
| `users.role` | `user` or `admin` |
| `users.suspended_at` | When the account was suspended, or null |
| `bug_reports` | Report ID, received time, description (up to 4,000 characters), version, platform, model, file names and sizes, status, closed time |
| `admin_events` | The admin, the action, the target and its label at the time (address, title, or description), a detail such as a suspension reason, and the time. No foreign keys, so an entry outlives the admin and the target |
| `catalog_salts` | Each UTC day's salt, until the day is over |
| `catalog_clients` | Day, client hash, version, platform, and architecture. No IP address |

## Cloudflare API Notes

- [Workers Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/): `POST /client/v4/accounts/<account_id>/analytics_engine/sql` with the query as the body. `FORMAT JSON` answers `{meta, data, rows}`. Counts can come back as strings. Install stats sum `_sample_interval`, because Analytics Engine samples busy datasets.
- [GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/): `POST /client/v4/graphql` with `{query, variables}`. `httpRequestsAdaptiveGroups` groups requests by dimensions such as `userAgent` and `date`. Errors arrive with status `200` in `errors`. On the Free plan, a query covers at most 30 days and reaches back at most 31.
- A JavaScript number bound to a D1 statement can arrive as REAL, so integer math in SQL uses `CAST(... AS INTEGER)`.
