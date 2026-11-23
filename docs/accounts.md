# Accounts

- [Introduction](#introduction)
- [Pages](#pages)
  - [Redirects](#redirects)
- [Accepting the Terms](#accepting-the-terms)
- [Signing In](#signing-in)
  - [Passwords](#passwords)
  - [Two-Step Verification](#two-step-verification)
  - [Passkeys](#passkeys)
  - [Sessions](#sessions)
- [Confirming It's You](#confirming-its-you)
- [Email](#email)
  - [Messages](#messages)
  - [Email Links](#email-links)
- [Changing the Email Address](#changing-the-email-address)
- [Security](#security)
- [Data Model](#data-model)
- [Cloudflare Resources](#cloudflare-resources)

## Introduction

Accounts let the pi CLI share sessions to pi-rust.com. The Worker code is in `worker/accounts/`; the pages are in `src/pages/account/` and `src/pages/device.astro`, with their scripts in `src/scripts/account/`. The pages are static, and their scripts call the JSON API under `/api/account/`.

Sharing is described in [Session Sharing](sharing.md), and moderation in [Admin Area](admin.md).

## Pages

| Page | What it does |
| --- | --- |
| `/account/sign-up/` | Email, then password and the Terms box. The reply is always "Check your email" |
| `/account/sign-in/` | Email, password, then the second step if the account has one. Or a passkey alone |
| `/account/verify/#token=` | Verifies the address from the email link |
| `/account/reset/` | Sends a reset link; `/account/new-password/#token=` sets the new password |
| `/account/` | Shares: copy, open, download, rename, set the expiry and who can open it, delete |
| `/account/security/` | Password, two-step verification, recovery codes, passkeys, browser sessions, and CLI tokens |
| `/account/settings/` | The address and its verification, changing the address, and deleting the account |
| `/account/confirm-email/#token=` | Confirms a new address |
| `/account/undo-email/#token=` | Undoes an address change |
| `/device/` | Approves or denies a pi CLI sign-in |

The pages are `noindex`, and are left out of the sitemap and the site search. Admins also see an "Admin" link to [`/admin/`](admin.md).

### Redirects

A signed-out visitor of `/account/`, `/account/security/`, `/account/settings/`, or `/device/` goes to `/account/sign-in/?next=<path>`. A signed-in visitor of sign-in or sign-up goes on to `next`, or to `/account/`.

`next` must be an `/account/`, `/admin/`, or `/device/` path, or a share (`/s/<id>`). The share 404 page links to sign-in with `next=/s/<id>`, so the owner of a private share gets back to it in one step.

## Accepting the Terms

The password step of sign-up has a required, unchecked box: "I am 18 or older, and I agree to the Terms of Service. I have read the Privacy Policy." Both names open `/terms/` and `/privacy/` in a new tab, so the form keeps what was typed.

The page sends `acceptTerms: true` and `termsVersion` (the `TERMS_VERSION` it was built with) with the email and password. `POST /api/account/sign-up` answers:

| Answer | When |
| --- | --- |
| `400 terms_required` (with `field: "acceptTerms"`) | `acceptTerms` is not `true` |
| `409 terms_changed` | `termsVersion` is not the current `TERMS_VERSION`, so a page opened before a Terms change cannot record the new version |

Both checks come after the email and password checks, and before the Worker reads or writes an account or sends email, so they reveal nothing about which addresses have accounts. If the insert fails and the address still has no account, the request fails instead of answering "Check your email".

A new account stores `TERMS_VERSION` from `src/lib/legal.ts` in `users.terms_version`, and the time in `users.terms_accepted_at`. Accounts created before `migrations/0007_terms_acceptance.sql` have both null. Sign-in does not ask anyone to accept again; see [Legal Pages](legal.md#changing-the-terms).

## Signing In

### Passwords

Passwords are 10 to 256 characters, and not the account's email address. They are hashed with PBKDF2-SHA256 (100,000 iterations, the most Workers allows, and a 16-byte random salt) over HMAC-SHA256 of the password with `AUTH_PEPPER`. The stored string is `pbkdf2-sha256$<iterations>$<pepper id>$<salt>$<hash>`, and a sign-in rehashes a password stored with older parameters.

Comparisons are constant time. A sign-in for an unknown address checks a dummy hash, so it takes as long as a real one. Every failure is one message: "Wrong email or password."

### Two-Step Verification

When an account has TOTP or a passkey, a correct password only starts a sign-in challenge (`__Host-pirs_signin` cookie, 10 minutes). A TOTP code, a recovery code, or a passkey finishes it. A challenge allows 5 wrong codes, then the sign-in starts over.

- **TOTP** follows RFC 6238: SHA-1, 6 digits, 30-second steps, and one step of drift. The secret is encrypted with AES-256-GCM (`TOTP_ENCRYPTION_KEY`, with the user ID as associated data). A step is accepted only after the last accepted one, so each code works once.
- **Recovery codes** are 10 codes of 10 characters, shown once and stored as HMAC-SHA256 with the pepper. Turning on TOTP makes a new set, and adding a passkey makes one when the account has none. They are removed when no second step is left.

### Passkeys

Passkeys use `@simplewebauthn/server`. The RP ID is the site host (`pi-rust.com`, or `localhost` in tests), and the expected origin is the site origin.

- Registration asks for a discoverable credential, with user verification preferred.
- Passwordless sign-in and re-authentication require user verification. A passkey as the second step after a password prefers it.
- A passwordless sign-in must also return the account's user handle.
- Each ceremony's challenge is stored for 5 minutes and deleted when used.

### Sessions

The session cookie is `__Host-pirs_session` (HttpOnly, Secure, SameSite=Lax, Path=/), with a 256-bit random token. D1 stores only its SHA-256.

- A session lasts 30 days from its last use, checked every 5 minutes of use.
- Sign-in starts a new session and ends the one the browser had. Sign-out deletes the row.
- Verifying the address, re-authenticating, and changing the password, TOTP, or passkeys give the session a new token.

## Confirming It's You

Sensitive actions need a password or passkey confirmation from the last 10 minutes. Without one, the API answers `403 reauth_required`, and the page asks "Confirm it's you". Signing in counts as a confirmation.

The actions are: changing the password or the email address, setting up or turning off TOTP, new recovery codes, adding or removing a passkey, signing out other sessions, deleting all shares, and deleting the account.

## Email

The Worker sends account email from `accounts@pi-rust.com` (`ACCOUNT_EMAIL_FROM`) through the `EMAIL` binding, as plain text and simple HTML (`worker/accounts/templates.ts`). It sends after the response, and a failed send is logged, never returned as an error.

### Messages

| Event | Subject |
| --- | --- |
| Sign-up, or "Send link again" | Verify your email for pi-rust |
| Sign-up with an address that has an account | Sign-up attempt for your pi-rust account |
| Reset requested | Reset your pi-rust password |
| Password changed or reset | Your pi-rust password was changed |
| TOTP turned on or off | Two-step verification is on / off |
| Passkey added or removed | A passkey was added to / removed from your pi-rust account |
| Recovery code used | A recovery code was used to sign in |
| Account deleted | Your pi-rust account was deleted |
| Address change, to the new address | Confirm your new email for pi-rust |
| Address change, to the old address | Your pi-rust email is about to change |
| Address change to an address that has an account | Email change attempt for your pi-rust account |
| Address changed, to the old address | Your pi-rust email was changed |
| Address change undone | The change of your pi-rust email was undone |

### Email Links

Links carry a 256-bit random token in the fragment (`#token=`), so it never reaches a server log or a `Referer`, and a mail scanner that opens the link does not use it up. The page reads the token, removes it from the address bar, and posts it. Tokens are stored as SHA-256 and work once.

| Link | Works for |
| --- | --- |
| Verify | 24 hours |
| Reset | 30 minutes |
| Confirm a new address | 24 hours |
| Undo an address change | 7 days |

A new link of the same kind replaces the old one. A reset deletes every session, CLI token, pending sign-in, and waiting address change of the account, and counts as verifying the address.

## Changing the Email Address

A signed-in user changes the address with "Change email" on `/account/settings/`. The code is `worker/accounts/email-change.ts`.

1. **Ask.** `POST /api/account/email/change` with `{"email"}` needs a recent confirmation. The new address gets a link, and the old address gets a notice that names the new one. Nothing changes yet: the account still signs in with the old address, and the Account page shows the waiting change with "Cancel the change". A new request replaces a waiting one, and a password change or reset cancels it.
2. **Confirm.** The link opens `/account/confirm-email/#token=`, which posts to `POST /api/account/email/confirm`. The account gets the new address, verified. Links sent to the old address stop working, and the old address gets an undo link. The change fails when the account no longer has the old address, or when the new address has another account by then (`409 email_taken`).
3. **Undo.** The undo link opens `/account/undo-email/#token=`, which posts to `POST /api/account/email/undo` only after "Undo the change" is pressed. Undoing puts the old address back, signs out everywhere, deletes every CLI token, replaces the password with one nobody knows, removes the passkeys and TOTP added since the change was asked for, and emails a link to set a new password. Someone who took over an account and moved it to their own address cannot keep it.

When the new address already has an account, the answer and the page are the same, and that address gets a notice instead of a link. A suspended account can neither confirm nor undo a change (`403 account_suspended`).

## Security

- **CSRF.** Every state-changing `/api/account/` request must be `Content-Type: application/json`, with an `Origin` equal to the site origin, and without `Sec-Fetch-Site: cross-site`. The site origin is `https://pi-rust.com`; only a request to `localhost` or `127.0.0.1` uses its own origin. The API never answers CORS preflights.
- **Enumeration.** Sign-up, reset, and address change requests answer the same whether or not the address has an account. The owner of a taken address gets an email instead.
- **Rate limits.** `AUTH_LIMITER` allows 10 requests per 60 seconds per client IP and route class: sign-in, sign-up, reset, verify, two-step, passkey, reauth, device, and email. `/oauth/token` is not limited by it; the device grant's `slow_down` covers polling.
- **Verification.** An unverified account can sign in, but cannot approve a CLI sign-in or upload a share.
- **Suspension.** An [admin](admin.md) can suspend an account. Its sessions, CLI tokens, and pending sign-ins are deleted. After a correct password or passkey, sign-in answers `403 account_suspended`; a wrong password still gets the usual message. Its shares answer `404`.
- **Deletion.** Deleting an account deletes its shares from R2, then every row that belongs to it.
- **Headers.** API responses send `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`. The account pages send a CSP with `script-src 'self' 'wasm-unsafe-eval'`: Astro builds every script as a file (`astro.config.mjs`), and the site search needs WebAssembly.

## Data Model

Accounts live in the D1 database `pi-rust-accounts`. Times are Unix milliseconds.

| Table | Holds |
| --- | --- |
| `users` | Email (unique, case-insensitive), verified time, password hash, TOTP secret (encrypted), last TOTP step, WebAuthn user handle, role, suspended time, and the Terms version accepted at sign-up and when |
| `sessions` | SHA-256 of the cookie token, a coarse device label ("Chrome on macOS"), created, last seen, expiry, last confirmation |
| `sign_in_challenges` | A password sign-in waiting for its second step |
| `email_tokens` | Verify and reset links |
| `email_changes` | Address changes: purpose (`confirm` or `undo`), old and new address, when the change was asked for |
| `recovery_codes` | 10 per user, as HMAC-SHA256 |
| `passkeys` | Credential ID, public key, counter, transports, device type, backup flag, AAGUID, name, last used |
| `webauthn_challenges` | One per passkey ceremony, for 5 minutes |
| `cli_tokens` | SHA-256 of each `pirs_` token, name, created, last used |
| `device_codes` | pi CLI sign-in requests |
| `shares` | Share records; see [Session Sharing](sharing.md) |
| `bug_reports`, `admin_events`, `catalog_salts`, `catalog_clients` | The [admin area](admin.md) |
| `dev_mailbox` | [Local development](development.md#the-dev-mailbox) only; empty in production |

The hourly cleanup (`worker/cleanup.ts`) deletes expired device codes, sign-in challenges, email links, address changes, and passkey challenges.

## Cloudflare Resources

| Resource | Setting |
| --- | --- |
| D1 | Database `pi-rust-accounts`, binding `DB`, migrations in `migrations/` |
| Email | Binding `EMAIL`, sender `accounts@pi-rust.com`, any recipient. pi-rust.com is onboarded to Email Sending (return path `cf-bounce.pi-rust.com`, DKIM selector `cf-bounce`, DMARC `p=reject`) |
| Rate limit | `AUTH_LIMITER`, namespace `4103`, 10 per 60 s |
| Variable | `ACCOUNT_EMAIL_FROM` = `accounts@pi-rust.com` |
| Secrets | `AUTH_PEPPER` and `TOTP_ENCRYPTION_KEY`; see [Deployment](deployment.md#secrets) |
