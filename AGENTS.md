# AGENTS.md

## Vendored Repositories

External repositories may be vendored locally under `./repos` as read-only reference material. `./repos` is git-ignored: it is never committed or pushed, so it stays out of the published history.

When the directory is present, prefer examples from its source over search results.

Do not import from `./repos`; application code should continue importing from normal package dependencies.
