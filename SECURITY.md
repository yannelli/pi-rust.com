# Security Policy

- [Supported Versions](#supported-versions)
- [Reporting a Vulnerability](#reporting-a-vulnerability)
- [Scope](#scope)

## Supported Versions

Only the live site, <https://pi-rust.com>, and the `main` branch of this repository are supported. Security fixes deploy from `main`.

## Reporting a Vulnerability

Please report a vulnerability privately, in either of these ways:

- Use **Report a vulnerability** on this repository's [Security tab](https://github.com/yannelli/pi-rust.com/security/advisories/new).
- Email <security@pi-rust.com>.

Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.

Include as much as you can to help us understand and reproduce the issue:

- The type of vulnerability
- The affected URL, endpoint, or source file
- Step-by-step instructions to reproduce it
- Proof-of-concept or exploit code, if you have it
- The impact, including how an attacker might use it

You can expect a reply within 48 hours. We will work with you to confirm the issue, and keep you informed until it is fixed.

## Scope

This policy covers pi-rust.com and the Worker in this repository: accounts, session sharing, the admin area, and the endpoints the pi CLI calls. For the pi-rust CLI itself, see the [pi-rust repository](https://github.com/yannelli/pi-rust/security).

Please test only against your own account and your own shares, and do not degrade the service for others.
