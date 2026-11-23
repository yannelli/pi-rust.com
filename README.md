# pi-rust.com

The website of [pi-rust](https://github.com/yannelli/pi-rust), the Rust port of the pi coding agent. Live at <https://pi-rust.com>.

- [Introduction](#introduction)
- [Getting Started](#getting-started)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Introduction

pi-rust.com is a static [Astro](https://astro.build) site on a Cloudflare Worker. Besides the pages, the Worker runs the services the pi-rust CLI talks to:

- **Pages.** Home, install, benchmarks, changelog, FAQ, and the docs. The docs come from the pi-rust repository at each release, and a new release reaches the site on its own.
- **Install scripts.** `/install.sh` and `/install.ps1`, served unchanged from the pi-rust repository.
- **Accounts and sharing.** Accounts with GitHub sign-in, passkeys, and two-step verification, the pi CLI sign-in, and shared sessions at `/s/<id>`.
- **Admin area.** Stats, moderation, and the bug report inbox, at `/admin/`.
- **Legal pages.** The privacy policy and Terms of Service, at `/privacy/` and `/terms/`. Sign-up requires accepting the Terms.
- **pi CLI endpoints.** Bug reports, opt-in install telemetry, and the model catalog.

pi-rust is built and maintained by [Ryan Yannelli](https://ryanyannelli.com/). Its project page is <https://ryanyannelli.com/projects/pi-rust/>.

## Getting Started

You need Node.js 22 or later:

```sh
npm install
npm run dev     # pages only, at http://localhost:4321
npm run build   # type-check and build dist/
npm test        # Playwright against the Worker in wrangler dev
```

[Local Development](docs/development.md) covers running the Worker, local accounts, and the tests.

## Documentation

**Getting Started:** [Local Development](docs/development.md), [Deployment](docs/deployment.md), [Content and Releases](docs/content.md)

**The Site:** [Design](docs/design.md), [Search and Indexing](docs/seo.md), [Legal Pages](docs/legal.md)

**Accounts:** [Accounts](docs/accounts.md), [Session Sharing](docs/sharing.md), [Admin Area](docs/admin.md)

**pi CLI Endpoints:** [Bug Reports](docs/bug-reports.md), [Install Telemetry](docs/install-telemetry.md), [Model Catalog](docs/model-catalog.md)

## Contributing

The docs pages on pi-rust.com come from the [pi-rust repository](https://github.com/yannelli/pi-rust); fix them there. For changes to the site itself, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please report a vulnerability privately. See [SECURITY.md](SECURITY.md).

## License

The site code is open-sourced under the [MIT license](LICENSE.md). The docs text comes from pi-rust, which is MIT licensed by Mario Zechner and Ryan Yannelli.
