# humans.sh

A local MCP server that agents use to ask humans questions, plus a terminal inbox TUI for answering them.

Agents connect over MCP and post `ask` or `notify` messages; the TUI shows a live inbox over WebSocket where you can read and answer pending questions.

## Packages

- `@humans/protocol` — shared message types and WebSocket protocol
- `@humans/server` — MCP + WebSocket server
- `@humans/tui` — terminal inbox
