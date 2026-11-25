---
title: "Quick start"
description: "The commands to start pi in a project, run one prompt, resume a session, and pick a model."
group: "Get started"
order: 1
source: "README.md"
ref: "v0.12.40"
lead: true
---

```sh
# set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ...)
# or run /login
export ANTHROPIC_API_KEY=...

# interactive session in the current directory
pi

pi -p "Summarize src/main.rs"       # print mode: run once, print the answer
pi --mode json -p "List the TODOs"  # one JSON event per line
pi --mode rpc                       # JSON-RPC over stdio for other programs
pi -c                               # continue the latest session here
pi -r                               # pick a session to resume
pi --model openai/gpt-5.5 --thinking high
pi @notes.md @screenshot.png "What changed?"
cat error.log | pi -p "Explain this error"

# install a pi package (extensions, skills, themes)
pi install npm:<package>
```

Run `pi --help` to see all options. In interactive mode, type `/` to see the commands.
