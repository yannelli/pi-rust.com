# Contributing

- [Where Changes Belong](#where-changes-belong)
- [Bug Reports](#bug-reports)
- [Pull Requests](#pull-requests)
- [Development Workflow](#development-workflow)
- [Guidelines](#guidelines)

## Where Changes Belong

pi-rust.com shows content from the [pi-rust repository](https://github.com/yannelli/pi-rust), so many fixes belong there:

| You want to change | Change it in |
| --- | --- |
| A docs page, the changelog, or the benchmark report | yannelli/pi-rust. The site syncs it at the next release, or sooner for a `docs:` commit |
| The pi-rust CLI, or a contract it uses (bug reports, telemetry, model catalog, sharing) | yannelli/pi-rust, then here |
| The site's pages, styles, Worker, accounts, or admin area | This repository |

Files under `src/content/` and `src/data/upstream.json` are written by `npm run sync`. A pull request that edits them by hand cannot be merged.

## Bug Reports

Open an issue with a clear title, the page or endpoint, what you expected, what happened, and your browser or pi-rust version. For a security issue, follow [SECURITY.md](SECURITY.md) instead.

## Pull Requests

Keep a pull request to one change, and describe why it is needed. Before you open one:

1. Fork the repository and branch from `main`.
1. Add or update tests for the behavior you change.
1. Run `npm run build` and `npm test`, and make sure both pass.
1. Update the docs in `docs/` when you change behavior they describe.

Commit messages use [Conventional Commits](https://www.conventionalcommits.org), such as `fix(accounts): ...` or `docs(admin): ...`.

## Development Workflow

```sh
npm install
npx playwright install chromium
npm run build
npm test
```

[Local Development](docs/development.md) covers running the Worker, local accounts, and the test routes.

## Guidelines

- Follow [Design](docs/design.md) for colors, type, components, and writing.
- A new D1 change is a new file in `migrations/`; never edit one that has been applied.
- Keep the IP address out of everything the Worker stores, as the existing code does.
- Shared sessions stay out of search: keep the `X-Robots-Tag` on every `/s/` and `/session/` response.
