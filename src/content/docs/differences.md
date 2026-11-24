---
title: "Differences from upstream pi"
description: "What pi-rust adds to the TypeScript pi, where its runtime behaves differently, and which upstream bugs it already fixes."
group: "Get started"
order: 4
source: "README.md"
ref: "v0.12.37"
lead: true
---

pi-rust ports the upstream `pi` CLI and its libraries. This section lists the differences and SDK limits.

## Runtime

- New Kimi Code OAuth logins use the global `.ai` endpoints.
  - For a mainland China login, set `KIMI_CODE_OAUTH_HOST=https://auth.kimi.com`.
  - A new login stores its OAuth and API endpoints for later refreshes. Older logins without this metadata keep their mainland endpoints.
  - `KIMI_CODE_OAUTH_HOST` and `KIMI_CODE_BASE_URL`, when set, override the saved endpoints. A custom model `baseUrl` in `models.json` stays in effect.
- Kimi and Moonshot tool requests infer omitted types from enums, constants, and unambiguous schema structure.
- QuickJS answers `localhost` and loopback reverse queries locally. It rejects `onion` and `invalid` names and their subdomains without contacting a DNS server. If the OS supplies no DNS servers, `getServers()` returns an empty list. Extensions can supply a server with `setServers()`. See [DNS behavior](https://github.com/yannelli/pi-rust/blob/v0.12.37/docs/parity/GAPS.md#extension-runtime-pi-js).
- Extensions run on an embedded QuickJS engine, so pi-rust does not need Node.js. All Node built-in modules load. These include:
  - `zlib` with gzip, brotli, and zstd.
  - `async_hooks` with `AsyncLocalStorage`, and `v8` serialization.
  - The network modules `net`, `tls`, `dgram`, `dns`, `http`, `https`, and `http2`. On Windows, QuickJS uses the adapter metric alone if it cannot read the system route table.
  - `vm` contexts with timeouts, `worker_threads`, and `cluster`. They can send socket and server handles over inter-process communication (IPC).
  - `node:sqlite` on the bundled SQLite, `node:test` with TAP and spec output, and `repl` over any streams.
  - In-process `inspector` sessions, and `wasi` with a `WebAssembly` global on the wasmi interpreter.

  The APIs that do not work throw `ERR_PI_UNSUPPORTED`. Examples are `crypto.subtle` other than `digest`, and rare `crypto` ciphers such as Camellia. `crates/pi-js/src/unsupported.rs` lists all of them. Native npm addons cannot load on QuickJS.

  To run extensions on Node 22 or later, set `extensionRuntime` to `"node"` or `"auto"`, or use `--extension-runtime` or `PI_EXTENSION_RUNTIME`. On Node, native addons, `child_process.fork`, and V8-only modules work. If Node is missing, pi uses QuickJS. See [Node backend](https://github.com/yannelli/pi-rust/blob/v0.12.37/docs/agents/node-compat.md#node-backend).
  The [extension package audit](https://github.com/yannelli/pi-rust/blob/v0.12.37/docs/parity/extension-packages.md) lists 25 tested packages and the engine each one used.
- IPC handle retries use a pi-js-specific wrapper. Internal handle listeners receive an object with only `close()`. Cluster connections queued to a disconnected worker are not reclaimed. See [Extension runtime](https://github.com/yannelli/pi-rust/blob/v0.12.37/docs/parity/GAPS.md#extension-runtime-pi-js).
- On non-Linux Unix, a concurrent child spawn can inherit an IPC socket before QuickJS marks it close-on-exec. Node closes inherited descriptors in its macOS `posix_spawn` path. See [Platform](https://github.com/yannelli/pi-rust/blob/v0.12.37/docs/parity/GAPS.md#platform).
- In extensions, `ctx.sessionManager` reads return copies of entries, except `getEntries()` of the extension's own session. Upstream pi returns its own entry objects from all reads.
  - As in upstream pi, `getEntries()` of the extension's own session returns the same entry objects on each call, and a message entry holds the message object that the `message_end` handlers received. The `context` of `turn_end` and `agent_before_settle` holds these objects too.
  - The other reads, such as `getEntry()` and `getBranch()`, return new copies on each call. Changes to returned entries do not change the session.
- The extension SDK still has gaps in child sessions, resource loading, and model runtimes.
  - A `DefaultResourceLoader` with extensions serves one child session for each `reload()`. Its factories run in the caller's extension host.
  - `SettingsManager` supports custom storage and queued writes, with limits on JSON values and live object references.

  See [Extension module exports](https://github.com/yannelli/pi-rust/blob/v0.12.37/docs/parity/GAPS.md#extension-module-exports) for the remaining differences.
- `pi.registerProvider(provider)` with an upstream `Provider` object, which has `getModels()` and no string `api`, registers nothing and reports a `register_provider` error. Use `pi.registerProvider(name, { api, baseUrl, models, streamSimple })`. An object with `id` and a string `api` registers as that config. See [Extension module exports](https://github.com/yannelli/pi-rust/blob/v0.12.37/docs/parity/GAPS.md#extension-module-exports).
- The providers that extensions get from `@earendil-works/pi-ai/providers/all` stream, classify, generate images, and resolve auth in Rust. Their API key login asks for one key, including for Amazon Bedrock, Google Vertex AI, and Cloudflare. See [Extension module exports](https://github.com/yannelli/pi-rust/blob/v0.12.37/docs/parity/GAPS.md#extension-module-exports).
- When you quit the interactive mode, pi waits at most 3 seconds for the running turn and the `session_shutdown` handlers, then exits. Upstream pi waits until they finish.
- An abort finishes in less than a second. Upstream pi waits for every tool and handler.
  - The running tools and the extension handlers of the run's last events share 400 ms. Slow handlers keep running without blocking.
  - RPC `abort` answers within 1.5 s.
  - A prompt sent while a run aborts starts after the run ends. Upstream pi rejects it.
  - Extension prompts that were waiting to start do not run. Upstream pi starts them.

  See [RPC mode](/docs/rpc/#abort).
- In RPC mode, extension dialogs wait until the client sends a command other than a `get_*` query. `get_commands` answers while a `session_start` handler waits for a dialog. Upstream pi sends dialogs at once and reads no input until its `session_start` handlers finish. See [RPC mode](/docs/rpc/#extension-dialogs).
- `grep` and `find` use the Rust `ignore` crate, so pi-rust does not download `rg` or `fd`.
- The version check and `pi update --self` use the releases of this repository.
- Newer models come from the catalog at `pi-rust.com` (`PI_CATALOG_URL` overrides it), which this repository generates from upstream's catalog generator at the upstream commit of the latest release. Upstream pi reads its catalog from `pi.dev`. See [Model catalog](https://github.com/yannelli/pi-rust/blob/v0.12.37/docs/model-catalog.md).
- `/bug` offers Upload Report, Open GitHub Issue, and Export as Zip. Upload Report sends the report privately to `pi-rust.com` (`PI_BUG_REPORT_URL` overrides it). Open GitHub Issue writes the zip archive and opens a public prefilled issue form on `yannelli/pi-rust`; you submit it and attach the zip yourself. Upstream pi uploads the report to its Radius gateway (`radius.pi.dev`).
- Install telemetry is off unless you turn it on with the `enableInstallTelemetry` setting or `PI_TELEMETRY=1`. When it is on, pi-rust sends the anonymous install and update ping (version and `User-Agent` only) to `pi-rust.com` (`PI_TELEMETRY_URL` overrides it). Upstream pi turns install telemetry on by default and pings `pi.dev`. For the same reason, the extension SDK's `SettingsManager.getEnableInstallTelemetry()` returns `false` when the setting is not set. Upstream returns `true`.
- `/share` can upload the session's HTML export to your pi-rust.com account. Set `sessionShareDestination` to `"pi-rust"`; if you are not signed in, the share first signs you in with a device code, and `/logout` signs you out. With `sessionShareViewer` set to `"pi-rust"`, gist links open on `pi-rust.com/session/` and `"auto"` uses the account first when you are signed in. By default both work as upstream pi: Radius or a gist, with gist links on `pi.dev`. `PI_SHARE_URL` replaces the `pi-rust.com` service origin. See [Settings](/docs/settings/#session-sharing).
- Shares on a pi-rust.com account can expire (`sessionShareExpiry`) and can be private to you (`sessionShareVisibility`). On pi-rust.com you can rename, download, and delete them, and see their view counts. Upstream pi has no such options.
- The first interactive `/share` asks where it sends sessions: pi.dev, as upstream pi does (Radius, or gists viewed on pi.dev), or a pi-rust.com account. pi.dev is the default, and nothing asks at startup. Upstream pi has no such question. See [Session sharing](/docs/settings/#session-sharing).
- The `providerIdentity` setting chooses how model provider requests identify pi-rust. With `"pi"` (the default), the `User-Agent` is `pi/<version>` with the upstream pi version that pi-rust has parity with, and attribution headers name pi and `pi.dev`. With `"pi-rust"`, the `User-Agent` is `pi-rust/<pi-rust version>`, and attribution headers name pi-rust and `pi-rust.com`. Attribution headers are sent only while install telemetry is on. Upstream pi always reports its own version. See [Settings](/docs/settings/#provider-identity).
- Word movement in Chinese, Japanese, Korean (CJK), and Thai text uses ICU4X dictionaries, so some word boundaries differ from `Intl.Segmenter` in Node.
- `pi-env` looks for remote daemons in a `pi-env-daemons` folder next to the `pi` program. Each release has a `pi-env-daemons-<tag>.tar.gz` archive with the daemons for Linux, Android (Termux), macOS, and Windows on x86-64 and arm64. Extract this archive in the folder that contains `pi`.
- `pi experimental` and its commands `server`, `client`, `durable`, and `vacation` need `PI_EXPERIMENTAL=1`, as in upstream pi. `server` and `client` use Unix sockets. On Windows, they show a message that they need Unix. Upstream pi also has no Windows transport.
- When a local shell command exits, pi-durable stops waiting for output as upstream does: 100 ms after the exit, or 100 ms after the last chunk that follows the exit. Then:
  - It delivers the queued chunks and any chunk that the readers finish reading before they observe the stop signal.
  - On Unix, it also takes at most 64 KiB more per stream, if that data is readable without waiting.
  - On Windows, it starts no further read.

  See [Platform](https://github.com/yannelli/pi-rust/blob/v0.12.37/docs/parity/GAPS.md#platform).
- When you clear the message queue, pi removes only your queued messages. Upstream pi drops queued extension messages with the queue.
  - Esc while the agent works, the dequeue key, and the RPC `clear_queue` command clear the queue.
  - Queued extension messages, such as subagent or background task results, stay queued.
  - When a run is aborted, queued extension messages join the conversation without starting a turn, so the agent sees them with your next prompt.
  - A message that an extension sends with `triggerTurn` while the run is ending continues that run. Upstream pi leaves that message queued until the next prompt.
- In a linked git worktree, pi reads the project files that the worktree lacks from the main checkout. Upstream pi reads only the worktree.
  - Files: `.pi/settings.json`, `.pi/mcp.json`, `.pi/SYSTEM.md`, and `.pi/APPEND_SYSTEM.md`.
  - Folders: `.pi/skills`, `.pi/prompts`, `.pi/extensions`, and `.pi/themes`.
  - The worktree's own copy wins.
  - Project packages and relative entries resolve from the folder of the settings file that applies.
  - A trust decision for the main checkout covers its worktrees, unless the worktree folder has its own.

  See [Settings](/docs/settings/#git-worktrees).
- Extension and login `select` menus show at most 10 options, with a `(n/total)` counter, so the selected option stays visible. Short terminals show fewer options. Upstream pi shows all options.
- An MCP server name in `mcp.json` or `pi.registerMcpServer` can have any characters except control characters and spaces at either end, for example `"Google Drive"` from a Claude Code plugin. In tool names and the server namespace, each character other than an ASCII letter, an ASCII digit, or `_` changes to one `_` for each UTF-16 unit (`😀` gives `__`), so `Google Drive` gives `mcp__Google_Drive`. pi rejects a server whose name gives the same namespace as an earlier server. `/mcp login`, `/mcp logout`, and `/mcp reconnect` use the rest of the line as the server name. Upstream pi accepts only letters, digits, `_`, and `-` in server names.

## Additions

| Addition | Upstream pi | Docs |
| --- | --- | --- |
| The slash commands `/diff`, `/init`, `/review`, `/context`, `/undo`, and `/retry` | Has none of them. Shows context use only in the footer. | [Interactive commands](/docs/commands/) |
| Markdown export: `/export notes.md` and `pi --export session.jsonl notes.md` | Exports only HTML and JSONL | [Export](/docs/commands/#export) |
| Prompt history across sessions, with the Ctrl+R search and the `promptHistory` settings | Keeps prompt history only while the process runs | [Prompt history](/docs/commands/#prompt-history) |
| Alt+Down (Alt+S on Windows, `app.message.sendNow`) sends the queued follow-ups after the current turn. It moves them to the steering queue. | Can only edit the queue or abort the turn | [Interactive commands](/docs/commands/) |
| Ctrl+Enter (`app.message.interrupt`) stops the agent, also during a long tool call, and sends the queued messages and the editor text as one prompt | Needs Esc, which moves the queue to the editor, and then Enter | [Interactive commands](/docs/commands/) |
| Esc clears the input draft when the agent is idle. Undo restores the draft. | | |
| Submitted slash commands join prompts and shell commands in the Up and Down history | | |
| `pi completion` and `pi doctor` | Has neither command | [CLI](/docs/cli/) |
| `pi sessions` and `pi stats` | Lists and deletes sessions only in its session picker (`pi -r` and `/resume`). Shows usage only for the current session (`/session`). | [Sessions](/docs/cli/#sessions) |
| `pi extensions` lists, installs, removes, enables, and disables extensions through the package and resource settings | | [Extensions](/docs/cli/#extensions) |
| `marketplace:` package sources, `pi extensions search`, and `pi extensions info`, which use signed indexes and checksummed native binaries | Has no Rust extension marketplace | [Marketplace](/docs/marketplace/) |
| The `/extensions` browser searches, installs, updates, removes, enables, and disables extensions, then offers a reload | Has no `/extensions` command | [/extensions](/docs/commands/#extensions) |
| Run limits (`--max-turns`, `--max-cost`) and structured output (`--output-schema`, `--output-retries`) | | [Run limits](/docs/cli/#run-limits) |
| `pi --mode acp`, with several sessions per connection and the client's stdio and HTTP MCP servers | Needs the separate pi-acp adapter. pi-acp accepts no HTTP MCP servers, keeps one session per connection, rejects a prompt while pi runs on its own, and ends failed turns with `end_turn`. | [ACP mode](/docs/acp/) |
| RPC and ACP modes run `/usage`, `/context`, `/extensions`, `/fast`, and `/reload` without a model call. RPC mode also runs `/session`, `/changelog`, `/export`, and `/name`. | Sends these prompts to the model in RPC mode | [RPC mode](/docs/rpc/) |
| Account model lists for OpenAI Codex, Anthropic, GitHub Copilot, OpenAI, xAI, Google, and Cursor | Limits only OpenRouter | [Account model lists](/docs/providers/#account-model-lists) |
| Claude Mythos 5.2 (`claude-mythos-5-2`) is in the `anthropic` catalog with the settings and prices of Claude Fable 5.2. pi removes it for an account whose model list does not name it. | Has no Mythos 5.2 model | [Account model lists](/docs/providers/#account-model-lists) |
| `/usage`, `pi usage`, and the native extension method `usage.get` show the subscription limits of the Claude, ChatGPT (Codex), Cursor, SuperGrok (`xai`, with Grok Build), and Google Antigravity logins | Has no usage report | [Subscription usage limits](/docs/usage-limits/) |
| Fast mode for models that have one: `/fast`, `--fast`, the `fastMode` setting, the ACP **Fast mode** option, and RPC `set_fast_mode` | Has no fast mode | [Fast mode](/docs/providers/#fast-mode-pi-rust-extension) |
| The subscription providers `cursor` and `google-antigravity` | Has none of them | [Subscription providers](/docs/providers/#cursor-and-google-antigravity-pi-rust-extension) |
| ACP agents as providers: Kiro CLI (V3), Amp, and the agents of the ACP registry run over stdio with their own tools. `/acp` installs and manages them. | Has no ACP client | [ACP agents](/docs/acp-agents/) |
| The global `disabledProviders` setting hides providers from model selection and keeps their credentials. The TUI `/settings` menu has a **Disabled providers** list. | | [Disable providers](/docs/providers/#disable-providers) |
| The global `rememberLastModel` setting (on by default) saves each model you switch to as the default | Saves the default model only with the selector's set-as-default key | [Remember the last model](/docs/providers/#remember-the-last-model-pi-rust-extension) |
| `/settings` items for the `retry.*` and `retry.provider.*` values | Sets these values only in `settings.json` | [Retry settings](/docs/providers/#retry-settings) |
| `listOverflow` and **List overflow** in `/settings`: truncate, wrap, or scroll long list rows; `PI_REDUCED_MOTION=1` disables scrolling | Truncates list rows | [List overflow](/docs/settings/#list-overflow) |
| A terminal notification when a run takes 10 seconds or more | Has this only as the example extension `notify.ts` | [Notifications](/docs/terminal/#notifications) |
| The status line and `/statusline`, as the `marketplace:statusline` extension | Changes the footer only through extensions | [Status line](/docs/status-line/) |
| More harness themes | | [Themes](/docs/terminal/#themes) |
| Mermaid `gantt` charts and `gitGraph` diagrams render as terminal art. Git graphs are always drawn top to bottom (`BT` flips them). | Shows these diagrams as source | |
| The iTerm2 integration and `/terminal-setup`, as the `marketplace:iterm2` extension | | [iTerm2 integration](/docs/terminal/#iterm2-integration) |
| The extension UI call `ctx.ui.writeTerminal(data, { tmuxPassthrough })` writes raw bytes to the terminal | Has no such call | |
| Footer data of `ctx.ui.setFooter` also has `getSessionStats()` (`input`, `output`, `cacheRead`, `cacheWrite`, `cost`, `contextTokens`, `contextWindow`, `contextPercent`) and `getRunState()` (`idle`, `working`, `blocked`, `done`, or `error`) | Has neither | |
| Native extensions: a package lists programs in `package.json` `pi.native`, and pi runs each one as an extension over a JSON-RPC protocol on stdio | Loads only TypeScript and JavaScript extensions | [Native extension protocol](/docs/native-extensions/) |
| Extensions call tools of the session's MCP servers outside a tool call, for example from a hook: `pi.callMcpTool(server, tool, args)` and the native method `mcp.callTool` | Has no MCP tool calls for extensions | [mcp.callTool](/docs/native-extensions/#mcp) |
| Extension events for hook runners: `instructions_loaded`, `prompt_expansion`, `notification`, `tool_call_blocked`, `cwd_changed`, and `before_provider_auth`. `session_start` handlers can call `ctx.switchSession()`. | Has none of these events. Only command contexts have `switchSession`. | [pi-rust events](/docs/native-extensions/#pi-rust-events) |
| A `session_before_compact` result can set `customInstructions` for that compaction. The text replaces the instructions of the event, so a handler that keeps them adds its text to `event.customInstructions`. | Reads only `cancel` and `compaction` | [Events](/docs/native-extensions/#events) |
| Native extensions draw the rows of tools without renderers, such as the built-in tools (`toolRenderers`). They can also animate a spinner inside drawn rows, refresh rows on a timer, read the TUI theme, and set the working indicator. | | [Renderers](/docs/native-extensions/#renderers) |
| `ctx.ui.setChatStyle` (`ui.setChatStyle`) puts prefixes before user and assistant messages, collapses finished thinking, and rounds the editor. It also sets the editor border color and the prompt layout (`frame`, `caret`, or `harbor`). | | [Chat style](/docs/native-extensions/#ui) |
| An expanded tool row can show an extension's view of the result (`pi.registerToolResultExpander`, native `toolResultExpander`), for example the full text behind a shortened result | Has no expander for other tools' results | [Renderers](/docs/native-extensions/#renderers) |
| Native extensions write their own top-level settings key in the global or a trusted project `settings.json` with `settings.set`. pi refuses its own setting keys. | Extensions have no settings write | [settings.set](/docs/native-extensions/#settings) |
| `pi.registerProvider` takes `oauth: { builtin: "<provider id>", name? }`: the provider logs in and refreshes with a login flow of pi, and stores the credential under its own id | Reuses a flow only through an imported OAuth object | [provider.register](/docs/native-extensions/#providers) |
| Extension widgets above and below the editor share a budget of a third of the terminal rows. Over the budget, each widget shows its first line. | Caps only text widgets, at 10 lines each | [/widgets](/docs/commands/#widgets) |
| MCP servers with `"lifecycle": "lazy"` in `mcp.json` connect on first use. A saved tool list makes their tools known before they connect. | Connects every enabled server when the session starts | [MCP server lifecycle](/docs/mcp/) |
| MCP elicitation: servers can ask the user for form data or to open a URL. The extension events `mcp_elicitation` and `mcp_elicitation_result` can answer a request or change the answer of the user. | Has no MCP elicitation | [MCP elicitation events](/docs/native-extensions/#mcp-elicitation-events) |
| The extension event `message_display` replaces the text of an assistant message on the screen in the TUI. The session and the model context keep the original text. | Has no display-only event. `registerMarkdownTransformer` changes the Markdown at each render. | [Events](/docs/native-extensions/#events) |
| Deferred context: the `contextExposure` setting and the skill frontmatter `exposure: deferred` keep skills and extension context entries, such as agent configs, out of the system prompt. `tool_search` finds them. | Lists every skill in the system prompt. Only tools can be deferred. | [Deferred context](/docs/deferred-context/) |
| A choice of extension engine: the `extensionRuntime` setting, `--extension-runtime`, and `PI_EXTENSION_RUNTIME` (`quickjs`, `node`, or `auto`) | Always runs extensions on Node | [Extension runtime](/docs/cli/#extension-runtime) |

## Bug fixes that are open upstream

The numbers are upstream issue numbers.

- If you remove a tool from the first tool list, later Anthropic requests do not fail (upstream issue 11376).
- On Bedrock, `strict: "prefer"` tools change to non-strict when the strict tools have more than 16 optional parameters (11416).
- `modelOverrides` in `models.json` also apply to classifier and image models: `name`, `input`, `inputLimits`, and `cost`. For classifiers, `contextWindow` and `compat` also apply (11223).
- The editor removes escape sequences from pasted text. If the end marker of a paste does not arrive, the paste ends after 10 seconds without input or at 16 MiB. Then Ctrl+C works again (11383).
- MCP HTTP replies that are plain JSON obey `maxMessageBytes` (11335).
- A code mode script can declare its own top-level `tools` or `console` (11226).
- Branch summaries from `/tree` use the selected thinking level (11444). If you resume a session after `/tree`, pi restores the thinking level that you used last (11451).
- pi removes mouse reports and other escape sequences with private parameters, such as `ESC[<35;59;1M`, from tool output (11377).
- In `pi -p`, a prompt that an extension command sends with `sendUserMessage` runs before pi exits (11238).
- An unpinned `-e npm:` package updates when npm has a newer version (11375).
- `pi.exec` keeps a maximum of 16 MiB of output from a command. It stops the command when the output gets to that limit (11360).
- `pi-env` watches a directory again after the kernel drops the watch and the directory keeps its inode (11342).
