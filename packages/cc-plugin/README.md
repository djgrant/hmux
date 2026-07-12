# hmux-cc-plugin

A Claude Code plugin that gives your sessions live presence on a local [hmux](../..) server: each session advertises its identity and status, and the human can route an agent's questions and progress through their inbox.

Requires [Bun](https://bun.sh) and an hmux server on `http://localhost:7373` (set `HMUX_URL` to override). If the server is down, every hook fails silently, so your session is never affected.

## Install

Straight from this repo, no install step:

```sh
claude --plugin-dir /path/to/hmux/packages/cc-plugin
```

Or persistently, via a local marketplace:

```sh
claude plugin marketplace add /path/to/hmux
claude plugin install hmux@hmux
```

## What it does

Claude Code's hooks run one script that talks plain HTTP to the hmux server. Sessions register on start, turn `busy` while working, surface a `message` when the agent needs or has left you something, and rest at `idle` otherwise. The plugin also declares the hmux MCP server, so the `ask` / `notify` / `signal` tools are available whenever it is enabled.

For headless (`-p`) runs, `hmux-run` routes permission prompts to your inbox:

```sh
hmux-run "run the release script" --agent release-bot
```

See the [repo README](../..) for the wider picture.
