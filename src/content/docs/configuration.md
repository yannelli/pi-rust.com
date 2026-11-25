---
title: "Configuration files"
description: "pi-rust uses your existing pi folder: logins, settings, models, key bindings, MCP servers, extensions, skills, and sessions."
group: "Get started"
order: 3
source: "README.md"
ref: "v0.12.40"
lead: true
---

pi-rust reads the same files as upstream pi, so the two can use one setup. To use a different folder in place of `~/.pi/agent`, set `PI_CODING_AGENT_DIR`.

| Path | Contents |
| --- | --- |
| `~/.pi/agent/auth.json` | API keys and OAuth logins from `/login` or `pi auth` |
| `~/.pi/agent/settings.json` | Settings. In a trusted project, `<project>/.pi/settings.json` overrides them. |
| `~/.pi/agent/models.json` | Custom providers and models |
| `~/.pi/agent/keybindings.json` | Key bindings |
| `~/.pi/agent/mcp.json`, `<project>/.pi/mcp.json` | MCP servers |
| `~/.pi/agent/{extensions,skills,prompts,themes}/` | Extensions, skills, prompt templates, and themes. `.pi/` in a project and `~/.agents/skills` also work. |
| `AGENTS.md`, `CLAUDE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md` | Context files and system prompt overrides |
| `~/.pi/agent/sessions/` | Sessions as JSONL trees in the pi format |
| `~/.pi/agent/prompt-history.jsonl` | The prompts that you sent, for Up, Down, and Ctrl+R (pi-rust only) |

When pi-rust starts for the first time, it moves files from older pi layouts, as upstream pi does. For example, it moves `oauth.json` into `auth.json`.
