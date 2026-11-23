---
title: "Crates"
description: "The Rust crates in the pi-rust workspace: pi-ai, pi-agent, pi-tui, pi-mcp, pi-js, pi-coding-agent, and the rest."
group: "Reference"
order: 50
source: "README.md"
ref: "v0.12.33"
lead: true
---

| Crate | Contents |
| --- | --- |
| [`pi-ai`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-ai) | Message types (JSON-compatible with pi), streaming events, providers, OAuth, the model registry, and catalogs |
| [`pi-agent`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-agent) | The agent loop, tool argument validation, and the stateful `Agent` |
| [`pi-tui`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-tui) | The terminal UI library: differential rendering, editor, markdown, images, and components |
| [`pi-mcp`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-mcp) | The MCP client (stdio and HTTP, OAuth) and server manager |
| [`pi-codemode`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-codemode) | Codemode: a sandboxed JavaScript runtime in which the model writes scripts that call tools |
| [`pi-js`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-js) | Embedded QuickJS with Node-style modules and TypeScript, for pi extensions |
| [`pi-coding-agent`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-coding-agent) | Tools, sessions, compaction, resources, extensions, the interactive TUI, the print, JSON, RPC, and ACP modes, and the `pi` CLI |
| [`pi-chord`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-chord) | Chord: an application composition runtime for services, replicated state, RPC, and plugins |
| [`pi-telemetry`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-telemetry) | Vendor-neutral telemetry contracts and typed schema utilities |
| [`pi-schema`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-schema) | TypeBox-compatible JSON Schema checks, defaults, and value cleanup, for pi-ai and pi-chord |
| [`pi-embedded`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-embedded) | In-process pi sessions for native and Rust applications, with a C ABI (`include/pi_embedded.h`) |
| [`pi-protocol`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-protocol), [`pi-client`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-client), [`pi-server`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-server) | The CBOR wire protocol, its client, and its server over Unix sockets |
| [`pi-durable`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-durable) | Pi Durable: durable sessions on memory, SQLite, or JSONL storage, the harness, and its coding tools |
| [`pi-env`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-env), [`pi-env-daemon`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-env-daemon) | Remote execution environments for Pi Durable over SSH, and the `pi-env` daemon that runs on the remote machine |
| [`pi-evals`](https://github.com/yannelli/pi-rust/tree/v0.12.33/crates/pi-evals) | Behavioral evals for the coding agent: host evals and a documentation-lift comparison in Docker (not published) |
