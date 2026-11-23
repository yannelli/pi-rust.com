# Legal Pages

- [Introduction](#introduction)
- [Where Things Live](#where-things-live)
- [Keeping the Privacy Policy True](#keeping-the-privacy-policy-true)
- [Changing the Terms](#changing-the-terms)
- [Audience](#audience)

## Introduction

pi-rust.com has a privacy policy at `/privacy/` and Terms of Service at `/terms/`, linked from the footer of every page. The Terms cover the hosted services only: accounts, session sharing, and the endpoints the pi CLI calls. The pi-rust app and this site's code are under their MIT licenses.

Sign-up requires accepting the Terms; see [Accounts](accounts.md#accepting-the-terms).

## Where Things Live

| File | Holds |
| --- | --- |
| `src/pages/privacy.astro` | The privacy policy, with its `EFFECTIVE` date |
| `src/pages/terms.astro` | The Terms of Service |
| `src/lib/legal.ts` | The operator, mailing address, phone, the legal and privacy addresses, the site repository URL, and `TERMS_VERSION` |

Privacy requests go to `privacy@pi-rust.com`. Terms questions and copyright notices go to `legal@pi-rust.com`.

## Keeping the Privacy Policy True

The privacy policy states what the site, the Worker, and Cloudflare collect, who sees it, and how long it is kept, as the Worker code and these docs describe it. When a change alters any of those, update the policy and its `EFFECTIVE` date in the same change. For example:

- A new table or column that holds personal data.
- A new retention period, or a change to one.
- Something new that admins can see.
- A new cookie or a new third party.

## Changing the Terms

Update `src/pages/terms.astro` and `TERMS_VERSION` together. `TERMS_VERSION` is the date the Terms took effect, and sign-up stores it as the version a user accepted, so change it only with new Terms text.

The Terms promise account holders an email 30 days before a material change. Sign-in does not ask them to accept again.

## Audience

Both pages say pi-rust.com is directed to the United States, not to the EEA, the UK, or Switzerland. Do not add EU languages, currencies, contact points, or marketing aimed there without revisiting both pages.
