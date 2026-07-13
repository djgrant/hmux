#!/usr/bin/env bun
/**
 * hmux entry point. `hmux advertise` is dispatched here, before the TUI and
 * its dependencies load: advertisers call it from hooks on every event, so
 * it has to start fast and must not be caught by the picker's isTTY guard.
 * `hmux mcp` likewise dispatches before the TUI: it runs headless on stdio,
 * so it must never touch the renderer. Everything else is the picker
 * (index.tsx).
 */

if (process.argv[2] === "advertise") {
  const { advertise, parseAdvertiseArgs } = await import("./advertise")
  const fields = parseAdvertiseArgs(process.argv.slice(3))
  if (!fields) {
    console.error(
      "usage: hmux advertise [--status <s>] [--detail <text>] [--agent <name>] [--resume <cmd>] [--transcript <path>] | --clear",
    )
    process.exit(2)
  }
  advertise(fields)
  process.exit(0)
}

if (process.argv[2] === "wait") {
  const { parseWaitArgs, waitForSettle } = await import("./wait")
  const args = parseWaitArgs(process.argv.slice(3))
  if (!args) {
    console.error("usage: hmux wait <target> [--timeout <seconds>]")
    process.exit(2)
  }
  const { findWindow } = await import("./backend")
  const { TmuxBackend } = await import("./tmux")
  const backend = new TmuxBackend(false)
  await backend.ensure()
  const result = await waitForSettle(
    async () => findWindow(await backend.list(), args.target)?.status,
    { timeoutMs: args.timeoutMs },
  )
  if (result.outcome === "settled") {
    console.log(result.status ?? "none")
    process.exit(0)
  }
  console.log(result.outcome) // "timeout" | "gone"
  process.exit(result.outcome === "timeout" ? 3 : 1)
}

if (process.argv[2] === "mcp") {
  const { serve } = await import("./mcp")
  await serve() // resolves when the client closes stdin
  process.exit(0)
}

await import("./index")

export {}
