# AGENTS.md

## Vendored Repositories

This project vendors external repositories under `./repos` as read-only reference material:

- `repos/effect` — [Effect-TS/effect](https://github.com/Effect-TS/effect) (`main`)
- `repos/opencode` — [anomalyco/opencode](https://github.com/anomalyco/opencode) (`dev`)
- `repos/opentui` — [anomalyco/opentui](https://github.com/anomalyco/opentui) (`main`)

Prefer examples from vendored source code over search results.

Do not import from `./repos`; application code should continue importing from normal package dependencies.
