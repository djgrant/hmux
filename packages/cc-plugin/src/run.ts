#!/usr/bin/env bun
/**
 * hmux-run — headless Claude Code with permission prompts in your inbox.
 *
 *   hmux-run "task..." [--agent name]
 *
 * Registers a session on the hmux server (so approvals/asks carry a
 * roster identity), writes a temp mcp-config whose hmux server sends the
 * identity headers (x-hmux-agent/-project/-session), then runs
 *
 *   claude -p "task" --permission-prompt-tool mcp__hmux__approve --mcp-config <tmp>
 *
 * streaming claude's output through. Permissions are NOT skipped — every
 * prompt lands in the mailbox's approvals section. The session is marked ended
 * when claude exits. Registration is best-effort: if the server is down we
 * warn and continue (approvals then block until it's back).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BASE = process.env.HMUX_URL ?? "http://localhost:7373"

export interface RunConfig {
  sessionId: string
  agent: string
  project: string
  /** JSON for --mcp-config: hmux server + identity headers. */
  mcpConfig: {
    mcpServers: {
      hmux: {
        type: "http"
        url: string
        headers: Record<string, string>
      }
    }
  }
  /** claude argv (after the binary), mcp-config path injected by the caller. */
  claudeArgs: (mcpConfigPath: string) => string[]
}

/**
 * Pure config assembly, separated from I/O so it's testable without
 * spawning claude or touching the network.
 */
export function buildRunConfig(opts: {
  task: string
  cwd: string
  base?: string
  agent?: string
  sessionId?: string
}): RunConfig {
  const base = opts.base ?? BASE
  const sessionId = opts.sessionId ?? crypto.randomUUID()
  const dirname = opts.cwd.split("/").filter(Boolean).pop() ?? "agent"
  const agent = opts.agent ?? `${dirname}-${sessionId.slice(0, 4)}`
  return {
    sessionId,
    agent,
    project: opts.cwd,
    mcpConfig: {
      mcpServers: {
        hmux: {
          type: "http",
          url: `${base}/mcp`,
          headers: {
            "x-hmux-agent": agent,
            "x-hmux-project": opts.cwd,
            "x-hmux-session": sessionId
          }
        }
      }
    },
    claudeArgs: (mcpConfigPath: string) => [
      "-p",
      opts.task,
      "--permission-prompt-tool",
      "mcp__hmux__approve",
      "--mcp-config",
      mcpConfigPath
    ]
  }
}

/** Parse `hmux-run "task..." [--agent name]`. Returns null on bad usage. */
export function parseArgs(argv: string[]): { task: string; agent?: string } | null {
  const words: string[] = []
  let agent: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--agent") {
      agent = argv[++i]
      if (agent === undefined) return null
    } else {
      words.push(arg)
    }
  }
  const task = words.join(" ").trim()
  if (task.length === 0) return null
  return { task, ...(agent !== undefined ? { agent } : {}) }
}

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed) {
    console.error('usage: hmux-run "task..." [--agent name]')
    process.exit(2)
  }
  const config = buildRunConfig({ task: parsed.task, cwd: process.cwd(), agent: parsed.agent })

  // Best-effort registration: identity headers work regardless (the agent
  // header is the fallback), but a registered session gives the roster
  // entry + liveness touches.
  try {
    await fetch(`${BASE}/sessions/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: config.sessionId,
        agent: config.agent,
        project: config.project
      }),
      signal: AbortSignal.timeout(2000)
    })
  } catch {
    console.error(`hmux-run: warning — could not register with ${BASE} (server down?)`)
  }

  const dir = mkdtempSync(join(tmpdir(), "hmux-run-"))
  const mcpConfigPath = join(dir, "mcp-config.json")
  writeFileSync(mcpConfigPath, JSON.stringify(config.mcpConfig))

  const child = Bun.spawn(["claude", ...config.claudeArgs(mcpConfigPath)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
  const exitCode = await child.exited

  try {
    await fetch(`${BASE}/sessions/${encodeURIComponent(config.sessionId)}/end`, {
      method: "POST",
      signal: AbortSignal.timeout(2000)
    })
  } catch {
    // Best-effort; the mailbox's staleness handling covers a missed end.
  }
  rmSync(dir, { recursive: true, force: true })
  process.exit(exitCode)
}

if (import.meta.main) {
  await main()
}
