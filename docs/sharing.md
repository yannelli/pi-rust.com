# Session Sharing

- [Introduction](#introduction)
- [Signing In From the CLI](#signing-in-from-the-cli)
- [Share API](#share-api)
  - [The Share Object](#the-share-object)
  - [Share Settings](#share-settings)
- [Share Pages](#share-pages)
  - [Who Can Open a Share](#who-can-open-a-share)
  - [Downloads](#downloads)
  - [Views](#views)
  - [Link Previews](#link-previews)
- [Indexing](#indexing)
- [The Gist Viewer](#the-gist-viewer)
- [Retention and Cleanup](#retention-and-cleanup)
- [Cloudflare Resources](#cloudflare-resources)

## Introduction

The pi CLI shares a session as one HTML file. pi-rust.com shows a shared session in two ways:

- **Account shares.** The CLI signs in to a pi-rust.com [account](accounts.md) and uploads the HTML, which is served at `https://pi-rust.com/s/<id>`. The code is `worker/share/`, and the CLI sign-in is `worker/accounts/device.ts`.
- **Gist shares.** The HTML is in a GitHub gist, and `https://pi-rust.com/session/#<gist id>` shows it (`src/pages/session.astro`).

> [!WARNING]
> The pi-rust client is built to the contract below. Do not change the sign-in, the share API, or `/s/<id>` without changing the client.

## Signing In From the CLI

The CLI signs in with the OAuth 2.0 device grant (RFC 8628):

1. The CLI posts `client_id=pi-cli&scope=share` (form-encoded) to `POST /oauth/device_authorization`, which answers:

   ```json
   {"device_code": "<43 characters>", "user_code": "BCDF-GHJK", "verification_uri": "https://pi-rust.com/device",
    "verification_uri_complete": "https://pi-rust.com/device?user_code=BCDF-GHJK", "expires_in": 900, "interval": 5}
   ```

2. The user opens the link. `/device` needs a signed-in account with a verified address. It shows the code, the client (such as "pi 0.12.26 on Linux", from the CLI's `User-Agent`), and when it asked, with Approve and Deny.
3. The CLI polls `POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=<code>&client_id=pi-cli` every `interval` seconds, until it gets a token:

   ```json
   {"access_token": "pirs_<43 characters>", "token_type": "Bearer", "scope": "share", "account": {"email": "<address>"}}
   ```

The user code is 8 letters from `BCDFGHJKLMNPQRSTVWXZ`, accepted in any case, with or without the dash. The device code is 256 random bits, stored as SHA-256, and stops working once it gives a token.

| Answer | When |
| --- | --- |
| `400 authorization_pending` | The user has not answered yet |
| `400 slow_down` | A poll came more than a second early. The interval grows by 5 seconds |
| `400 access_denied` | The user pressed Deny |
| `400 expired_token` | 15 minutes passed |
| `400 invalid_grant` | An unknown or used device code |
| `400 invalid_client`, `invalid_scope`, `invalid_request`, `unsupported_grant_type` | A request this flow does not accept |
| `429 rate_limited` | More than 10 device requests a minute from one IP (`AUTH_LIMITER`) |

CLI tokens have no expiry, and pi-rust.com stores only their SHA-256. The account's Security page lists them as "pi CLI", with their created and last used dates, and revokes them. A password reset revokes all of them.

## Share API

Every request sends `Authorization: Bearer pirs_...`. Errors are `{"ok": false, "error": "<code>", "description": "<text>"}`.

| Request | Success | Errors |
| --- | --- | --- |
| `GET /v1/account` | `200 {"ok": true, "account": {"email"}}` | `401 unauthorized` |
| `DELETE /v1/token` | `204`, and the calling token is revoked | `401 unauthorized` |
| `POST /v1/shares?title=&expires_in=&visibility=` with `Content-Type: text/html; charset=utf-8` | `201 {"ok": true, "share": {...}}` | `400 invalid_request`, `401 unauthorized`, `403 email_not_verified`, `413 too_large` (over 25 MiB), `415 unsupported_media_type`, `429 rate_limited` |
| `GET /v1/shares` | `200 {"ok": true, "shares": [...]}`, newest first | `401 unauthorized` |
| `PATCH /v1/shares/<id>` with JSON `{"title"?, "expiresIn"?, "visibility"?}` | `200 {"ok": true, "share": {...}}` | `400 invalid_request`, `401 unauthorized`, `404 not_found`, `415 unsupported_media_type` |
| `DELETE /v1/shares/<id>` | `204` | `401 unauthorized`, `404 not_found` |

`SHARE_LIMITER` allows 10 uploads per 60 seconds per token. `PATCH` and `DELETE` are not limited.

### The Share Object

Every response, and the account's Shares page, uses this shape:

```json
{"id": "<22 characters>", "url": "https://pi-rust.com/s/<id>", "title": "Fix the parser", "size": 48213,
 "createdAt": "2026-11-23T10:00:00.000Z", "expiresAt": "2026-11-30T10:00:00.000Z", "visibility": "link",
 "views": 12, "lastViewedAt": "2026-11-23T12:30:00.000Z"}
```

- `size` is in bytes, and times are ISO 8601.
- `expiresAt` is `null` for a share that never expires, and `lastViewedAt` is `null` before the first view.
- The ID is 128 random bits in base64url. Shares are unlisted: only the owner's Shares page links to them.
- `GET /v1/shares` also lists an expired share that the cleanup has not deleted yet.

### Share Settings

| Setting | Values |
| --- | --- |
| `title` | At most 200 characters; a longer one is cut, and control characters become spaces. Empty or missing: "Pi session" |
| `expires_in` (upload), `expiresIn` (`PATCH`) | Whole seconds from 3600 (1 hour) to 31536000 (365 days), counted from the request. `expiresIn: null` removes the expiry |
| `visibility` | `link` (anyone with the link) or `private` (only the owner, signed in on pi-rust.com) |

An upload without `expires_in` or `visibility`, as older clients send it, never expires and opens for anyone with the link. Any other value is `400 invalid_request`, and nothing is stored or changed. In JSON, `expiresIn` must be a number, not a string.

## Share Pages

`GET /s/<id>` (`worker/share/page.ts`) serves the stored HTML with these headers:

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox` |
| `X-Robots-Tag` | `noindex, nofollow, noarchive, nosnippet, noimageindex` |
| `Referrer-Policy` | `no-referrer` |
| `X-Content-Type-Options` | `nosniff` |
| `Cache-Control` | `private, no-cache` |

The sandbox has no `allow-same-origin`, so the page gets an opaque origin. Its scripts run, but it cannot read pi-rust.com cookies or storage, and its requests to the account API fail the origin check. `no-cache` makes every view check with the Worker, so a deleted, expired, or newly private share stops working at once.

### Who Can Open a Share

| Share | Answer |
| --- | --- |
| Unknown or deleted, or owned by a suspended account | `404`, the "Share not found" page |
| `private`, to anyone but its signed-in owner | The same `404` |
| `private`, to its signed-in owner | `200`, or `410` once expired |
| `link`, expired | `410`, "This share expired." |
| `link` | `200` for anyone |

A private share does not reveal that it exists. To anyone but its owner, it gets the same status, headers, and page as an unknown ID. The page's "Sign in" link goes to `/account/sign-in/?next=/s/<id>`, so a signed-out owner gets to a private share in one step. The owner opens a private share in the browser, signed in; a CLI token is not a browser session.

When anyone opens an expired share, the Worker deletes it after the response.

### Downloads

`/s/<id>?download=1` sends the HTML as it was uploaded, as `<title>.html`. The file name is the title in lowercase ASCII letters and digits joined by hyphens, at most 80 characters, or `pi-session`. The same rules decide who gets it.

### Views

A `GET` of a share, or its download, adds one to `views` and sets `lastViewedAt`. These do not count:

- The owner and admins, signed in.
- `HEAD` requests.
- Link-preview fetchers whose `User-Agent` contains `Slackbot`, `Discordbot`, `Twitterbot`, `facebookexternalhit`, `LinkedInBot`, `TelegramBot`, or `WhatsApp`.

Every reload counts. No IP address, user agent, or other detail of the viewer is stored.

### Link Previews

For a `link` share, the Worker adds these tags with `HTMLRewriter`, so a pasted link shows the title in chat apps:

| Tag | Content |
| --- | --- |
| `og:title` | The share title, HTML-escaped |
| `og:description` | A pi session shared on pi-rust.com |
| `og:site_name` | pi-rust |
| `og:type` | article |
| `twitter:card` | summary |

A private share gets no preview tags.

## Indexing

Shared sessions are never indexed:

- Every `/s/` and `/session/` response sends `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex`, including errors and redirects.
- Each served share gets `<meta name="robots" content="noindex, nofollow, noarchive">` as the first element of its `<head>`. A page without a `<head>` gets it before its `<title>` or `<body>`, where the browser still puts it in the head. Downloads are not changed.
- `robots.txt` lets search engines fetch these paths, so they see the `noindex`, and asks the AI crawlers it names to skip them. See [Search and Indexing](seo.md#crawlers).

## The Gist Viewer

`/session/#<gist id>` reads the gist ID from the fragment and fetches `https://api.github.com/gists/<id>` from the browser. It shows the first file whose name ends in `.html` (fetching its `raw_url` when GitHub marks it truncated) in an `<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" srcdoc="...">`, below a line with the gist's description and a link to the gist. It explains a missing link, a missing or private gist, GitHub's rate limit for anonymous requests (60 per hour per IP), and a gist without an HTML file.

A `srcdoc` frame inherits its page's CSP, so `/session/` sends only `frame-ancestors 'none'`; a script policy would also stop the shared session's own scripts. The frame's sandbox gives the session an opaque origin.

## Retention and Cleanup

A share lives until it expires, or until its owner or an [admin](admin.md) deletes it or its account. There is no lifecycle rule on the bucket.

An expired share stops opening at once (`410`). Its data is deleted the first time someone opens it, or by the hourly cleanup, whichever comes first. The cleanup (`worker/cleanup.ts`, cron `17 * * * *`) deletes up to 500 expired shares a run, oldest expiry first: the R2 object, then the row. A failed R2 delete leaves the row, so the next run tries again. The Worker's log shows each run's counts as `cleanup {"shares": ..., ...}`.

The Shares page also has "Delete expired" and "Delete all shares"; the second needs a [recent confirmation](accounts.md#confirming-its-you).

To read or check a share by hand:

```sh
npx wrangler r2 object get "pi-rust-shares/shares/<id>.html" --remote --file share.html
npx wrangler d1 execute pi-rust-accounts --remote --command "SELECT id, user_id, title, size, expires_at, visibility, view_count FROM shares WHERE id = '<id>'"
```

## Cloudflare Resources

| Resource | Setting |
| --- | --- |
| R2 | Bucket `pi-rust-shares`, binding `SHARES`. Objects are `shares/<id>.html` |
| D1 | The `shares`, `cli_tokens`, and `device_codes` tables in `pi-rust-accounts` |
| Rate limits | `SHARE_LIMITER` (namespace `4104`) for uploads; `AUTH_LIMITER` (namespace `4103`) for device requests and `/device` |
| Cron trigger | `17 * * * *`, the hourly cleanup |
