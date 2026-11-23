# Model Catalog

- [Introduction](#introduction)
- [Where the Data Comes From](#where-the-data-comes-from)
- [Contract](#contract)
  - [Choosing a Revision](#choosing-a-revision)
  - [Responses](#responses)
- [Users and Versions](#users-and-versions)
- [Checking the Catalog](#checking-the-catalog)

## Introduction

`GET https://pi-rust.com/api/models/providers/<id>` serves the model catalog that pi-rust reads for models newer than its bundled list. The code is `worker/model-catalog.ts`. The client sets the server with `PI_CATALOG_URL` (default `https://pi-rust.com`); upstream pi reads the same path from `pi.dev`.

## Where the Data Comes From

The pi-rust repository generates the catalog with upstream's generator, at the upstream commit of the latest pi-rust release, and publishes it to its `model-catalog` branch. The Worker reads that branch from `raw.githubusercontent.com`:

| File | Holds | Cached |
| --- | --- | --- |
| `models/v1/index.json` | `{"defaultRevision", "catalogs": [{"minimumPiVersion", "revision", "publishedAt", "upstreamCommit"}]}` | 5 minutes |
| `models/v1/revisions/<revision>/providers/<id>.all.json` | Every model type of a provider | A day; revisions never change |
| `models/v1/revisions/<revision>/providers/<id>.json` | A provider's chat models, by ID | A day |

> [!WARNING]
> Never edit the `model-catalog` branch by hand. The pi-rust repository's workflow publishes it.

`MODEL_CATALOG_SOURCE` replaces the base URL of `models/v1`; the tests use it.

## Contract

The protocol is upstream's (`scripts/model-catalog-protocol.ts` in earendil-works/pi), with pi-rust versions. The pi-rust client depends on it.

### Choosing a Revision

The client's version is `?pi-version=<x.y.z>`, or else the version in a `pi/<x.y.z>` or `pi-rust/<x.y.z>` `User-Agent`. The response is the revision with the highest `minimumPiVersion` at or below that version. Without a version, it is `defaultRevision`.

### Responses

- `?types=chat,image,classifier` returns the typed `.all.json` array. Without `types`, the response is the chat-only object of older clients.
- Every response sends `ETag: "<revision>-<typed|legacy>"`, `Last-Modified` from `publishedAt`, `Cache-Control: public, max-age=300`, and `Vary: User-Agent`. `If-None-Match` with the current ETag gets `304`.

Errors are `{"ok": false, "error": "<code>", "description": "<text>"}`:

| Status | Error | When |
| --- | --- | --- |
| `404` | `unknown_provider` | No such provider, or a provider ID that is not valid |
| `404` | `no_catalog` | The client is older than every catalog |
| `400` | `invalid_types` | A model type that is not a name |
| `400` | `invalid_version` | A version that is not semver |
| `405` | `method_not_allowed` | Not a `GET` or `HEAD` |
| `503` | `catalog_unavailable` | GitHub did not answer, or the index is not valid. Sent with `Retry-After: 300` |

The client treats a `404` as "use the bundled models", and keeps its cache on other errors.

## Users and Versions

After each catalog request from pi-rust, the Worker counts the client once a day, as a daily salted hash of its IP address, platform, and architecture, with its version (`worker/catalog-clients.ts`). It stores no IP address, and the response does not wait for it. See [Admin Area](admin.md#users-and-versions).

## Checking the Catalog

```sh
curl -sI -A "pi/0.12.26 (linux; rust; x64)" "https://pi-rust.com/api/models/providers/anthropic?types=chat,image,classifier"
curl -s https://raw.githubusercontent.com/yannelli/pi-rust/model-catalog/models/v1/index.json
```
