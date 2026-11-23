# Bug Reports

- [Introduction](#introduction)
- [Contract](#contract)
- [Storing a Report](#storing-a-report)
- [Reading Reports](#reading-reports)
- [Cloudflare Resources](#cloudflare-resources)
- [Cloudflare API Notes](#cloudflare-api-notes)

## Introduction

`POST https://pi-rust.com/v1/bug-reports` receives the reports that `/bug` uploads from pi-rust. The code is `worker/bug-reports.ts`. The client sets the server with `PI_BUG_REPORT_URL` (default `https://pi-rust.com`).

## Contract

The contract is the one of upstream pi's gateway (`core/bug-report-upload.ts`), so the client code stays a port.

> [!WARNING]
> The pi-rust client depends on this contract. Do not change it without changing the client.

The request is `multipart/form-data` with these parts:

| Part | Required |
| --- | --- |
| `report.json` | Yes, a JSON object |
| `diagnostics.json` | Yes, a JSON object |
| `session.jsonl` | No |
| `summary.md` | No |

A success is `201 {"ok": true, "bug_report": {"id": "<uuid>"}}`. The ID is the `id` in `report.json` when it is a UUID that is not stored yet, else a new UUID.

Errors are `{"ok": false, "error": "<code>", "description": "<text>"}`:

| Status | Error | When |
| --- | --- | --- |
| `405` | `method_not_allowed` | Not a `POST` |
| `415` | `unsupported_media_type` | Not `multipart/form-data` |
| `413` | `too_large` | Over 20 MiB |
| `429` | `rate_limited` | More than 5 reports a minute from one IP |
| `400` | `invalid_form` | An unknown part, a part sent twice, or a body that is not form data |
| `400` | `invalid_report` | `report.json` or `diagnostics.json` is not a JSON object |

## Storing a Report

1. The Worker writes each part to the R2 bucket `pi-rust-bug-reports` as `bug-reports/<id>/<part>`. A lifecycle rule deletes them after 90 days.
2. It adds a row to the `bug_reports` table, which lists the report in the [admin area](admin.md#bug-report-list). A failed write is logged, and the hourly cleanup adds the missing row.
3. It emails the report from `bugs@pi-rust.com` to the `BUG_REPORT_TO` secret: the description, version, platform, model, counts, a link to the report in the admin area, and the parts as attachments up to 15 MiB in total. Larger parts stay in R2 only.

A failed email is logged, and the upload still succeeds, because the files are in R2. Without `BUG_REPORT_TO`, as in `wrangler dev`, the Worker stores the report and logs a warning instead of sending email.

## Reading Reports

Admins read, download, close, and delete reports at `https://pi-rust.com/admin/bug-reports/`. You may also read the files with wrangler:

```sh
npx wrangler r2 object get "pi-rust-bug-reports/bug-reports/<id>/session.jsonl" --remote --file session.jsonl
npx wrangler tail pi-rust-com   # live logs, including email failures
```

## Cloudflare Resources

| Resource | Setting |
| --- | --- |
| R2 | Bucket `pi-rust-bug-reports`, binding `BUG_REPORTS`, lifecycle rule `expire-bug-reports` (prefix `bug-reports/`, 90 days) |
| D1 | The `bug_reports` table in `pi-rust-accounts` |
| Email | Binding `BUG_EMAIL`, sender `bugs@pi-rust.com`. The recipient must be a verified Email Routing destination |
| Rate limit | `BUG_REPORT_LIMITER`, namespace `4101`, 5 per 60 s |
| Variable | `BUG_REPORT_FROM` = `bugs@pi-rust.com` |
| Secret | `BUG_REPORT_TO`, the recipient, kept out of the repository |

## Cloudflare API Notes

- [Email Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/): `send({ to, from, subject, text, attachments })`. An attachment is binary or base64, and a message is at most 25 MiB. Base64 adds a third, so attachments stop at 15 MiB. An unverified recipient fails with `E_RECIPIENT_NOT_ALLOWED`.
- [Send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/): the recipient is not in `wrangler.jsonc`, so the binding restricts only the sender.
- [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/): `limit({ key })` returns `{ success }`. Counts are per Cloudflare location and approximate.
