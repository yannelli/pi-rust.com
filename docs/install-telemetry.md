# Install Telemetry

- [Introduction](#introduction)
- [Contract](#contract)
- [What Is Stored](#what-is-stored)
- [Reading the Data](#reading-the-data)
- [Cloudflare Resources](#cloudflare-resources)
- [Cloudflare API Notes](#cloudflare-api-notes)

## Introduction

`GET https://pi-rust.com/api/report-install?version=<version>` receives the install and update ping of pi-rust. The code is `worker/install-telemetry.ts`.

The ping is off by default. pi-rust sends it only when a user sets `enableInstallTelemetry` to `true` or sets `PI_TELEMETRY=1`, once after an install or an update. The client sets the server with `PI_TELEMETRY_URL` (default `https://pi-rust.com`).

## Contract

The request is the one upstream pi sends to `pi.dev/api/report-install` (`core/telemetry.ts`), so the client code stays a port.

> [!WARNING]
> The pi-rust client depends on this contract. Do not change it without changing the client.

- **Request:** `GET` with the query parameter `version`, a semantic version such as `0.12.26` or `1.2.3-beta+1`. The `User-Agent` is `pi/<version> (<platform>; rust; <arch>)`, such as `pi/0.12.26 (darwin; rust; arm64)`.
- **Success:** `204`, with no body.
- **Errors:** `{"ok": false, "error": "<code>", "description": "<text>"}` with `405 method_not_allowed`, `429 rate_limited`, or `400 invalid_version`.

The client ignores the response and gives up after 5 seconds.

## What Is Stored

The Worker limits each client IP address to 10 pings in 60 seconds (`INSTALL_TELEMETRY_LIMITER`), then writes one data point to the Analytics Engine dataset `pi_rust_install_telemetry`:

| Column | Value |
| --- | --- |
| `blob1` | The version from the query |
| `blob2` | The platform from the `User-Agent` (`darwin`, `linux`, `win32`, ...), or `unknown` |
| `blob3` | The architecture from the `User-Agent` (`x64`, `arm64`, ...), or `unknown` |
| `blob4` | `pi-rust` when the `User-Agent` has the pi-rust format, else `other` |
| `index1` | The version, as the sampling key |
| `timestamp` | Set by Analytics Engine |

The Worker does not store the IP address, the country, the full `User-Agent`, or any ID, so a ping cannot be linked to a person or to another ping. The rate limiter counts in memory. Analytics Engine keeps data points for 3 months.

## Reading the Data

The [admin area](admin.md#install-stats) shows pings per day, version, and platform for the last 30 days. To query the data yourself, create an API token with Account Analytics Read, then call the SQL API:

```sh
curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  --header "Authorization: Bearer $CLOUDFLARE_ANALYTICS_TOKEN" \
  --data "SELECT blob1 AS version, SUM(_sample_interval) AS pings FROM pi_rust_install_telemetry WHERE timestamp > NOW() - INTERVAL '30' DAY GROUP BY version ORDER BY pings DESC"
```

Group by `blob2, blob3` for platforms and architectures. Use `SUM(_sample_interval)`, not `COUNT()`, because Analytics Engine can sample busy datasets.

## Cloudflare Resources

| Resource | Setting |
| --- | --- |
| Analytics Engine | Binding `INSTALL_TELEMETRY`, dataset `pi_rust_install_telemetry`. The first write creates the dataset |
| Rate limit | `INSTALL_TELEMETRY_LIMITER`, namespace `4102`, 10 per 60 s |

## Cloudflare API Notes

- [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/get-started/): `writeDataPoint({ blobs, doubles, indexes })` takes ordered arrays and at most one index, and does not return a promise. `wrangler dev` runs the binding locally and sends nothing to Cloudflare.
- [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/): `POST /client/v4/accounts/<account_id>/analytics_engine/sql`, with the query as the body.
