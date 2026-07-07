/**
 * humans.sh Claude Code hook. One script for all six events, dispatched on
 * hook_event_name from the stdin JSON:
 *
 *   SessionStart     -> POST /sessions/register   (project = cwd, agent = dirname-<id prefix>)
 *   UserPromptSubmit -> POST /sessions/:id/status {status: "working"}
 *                       + GET /sessions/:id; if bound, emit additionalContext
 *   PostToolUse      -> POST /sessions/:id/status {status: "working"}   (heartbeat)
 *                       + GET /sessions/:id; if bound and not yet injected
 *                       this session (marker file), emit additionalContext
 *   Stop             -> POST /sessions/:id/status {status: "idle"}
 *   Notification     -> POST /sessions/:id/status {status: "needs-attention"}
 *   SessionEnd       -> POST /sessions/:id/end (+ clear marker)
 *
 * PostToolUse is the heartbeat: every status call bumps last_seen on the
 * server, so an actively-working agent stays fresh in the TUI roster. A
 * session sitting idle at the prompt fires no periodic hook and genuinely
 * cannot heartbeat — the TUI renders it as stale-but-listed instead.
 * PostToolUse also picks up MID-TASK binds: the human can bind a session
 * while it works, and the very next tool call injects the bound context.
 *
 * A hook must never break a Claude Code session: every fetch has a short
 * timeout and every failure path exits 0 with no output.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const BASE = process.env.HUMANS_URL ?? "http://localhost:7373"
const FETCH_TIMEOUT_MS = 2000

// Marker files make the PostToolUse context injection cheap-idempotent: the
// marker exists while the bound context has already been injected into THIS
// session. Cleared on SessionStart (fresh conversation), on unbind (so a
// re-bind re-injects), and on SessionEnd. All operations are failure-silent.
const STATE_DIR = process.env.HUMANS_STATE_DIR ?? join(homedir(), ".humans")
const markerPath = (id: string) => join(STATE_DIR, `bound-${encodeURIComponent(id)}`)
const markerExists = (id: string): boolean => {
  try {
    readFileSync(markerPath(id))
    return true
  } catch {
    return false
  }
}
const writeMarker = (id: string) => {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(markerPath(id), "1")
  } catch {}
}
const clearMarker = (id: string) => {
  try {
    rmSync(markerPath(id), { force: true })
  } catch {}
}

interface HookInput {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  model?: unknown
}

interface SessionInfo {
  bound?: boolean
  agent?: string
  project?: string
}

const request = async (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })

const post = (path: string, body?: unknown) =>
  request(path, {
    method: "POST",
    ...(body !== undefined
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }
      : {})
  })

const modelName = (model: unknown): string | undefined => {
  if (typeof model === "string") return model
  if (typeof model === "object" && model !== null) {
    const m = model as Record<string, unknown>
    if (typeof m.display_name === "string") return m.display_name
    if (typeof m.id === "string") return m.id
  }
  return undefined
}

// The injected context carries the session's ROSTER identity so the agent's
// ask/notify messages correlate with its roster entry in the inbox (instead
// of arriving under a self-declared name like "claude").
const boundContext = (session: SessionInfo): string => {
  const identity =
    typeof session.agent === "string" && session.agent.length > 0
      ? ` On every mcp__humans__ask and mcp__humans__notify call pass agent: "${session.agent}"` +
        (typeof session.project === "string" && session.project.length > 0
          ? ` and project: "${session.project}"`
          : "") +
        " so your messages correlate with your roster entry."
      : ""
  return (
    "This session is bound to a human inbox via humans.sh. When you need a decision, " +
    "clarification, or approval, ask the human with the mcp__humans__ask tool instead of " +
    `guessing. Send progress updates and completions with mcp__humans__notify.${identity}`
  )
}

/** GET the session, or undefined on any failure (server down, 404, bad JSON). */
const getSessionInfo = async (encoded: string): Promise<SessionInfo | undefined> => {
  try {
    const res = await request(`/sessions/${encoded}`)
    if (!res.ok) return undefined
    return (await res.json()) as SessionInfo
  } catch {
    return undefined
  }
}

const main = async () => {
  let input: HookInput
  try {
    input = JSON.parse(await Bun.stdin.text())
  } catch {
    return
  }
  const id = input.session_id
  if (typeof id !== "string" || id.length === 0) return
  const encoded = encodeURIComponent(id)

  switch (input.hook_event_name) {
    case "SessionStart": {
      const cwd = typeof input.cwd === "string" ? input.cwd : undefined
      const dirname = cwd?.split("/").filter(Boolean).pop()
      const model = modelName(input.model)
      // Fresh conversation: whatever context an earlier run injected is gone,
      // so clear the marker and let the next bound check re-inject.
      clearMarker(id)
      await post("/sessions/register", {
        id,
        ...(dirname !== undefined ? { agent: `${dirname}-${id.slice(0, 4)}` } : {}),
        ...(cwd !== undefined ? { project: cwd } : {}),
        ...(model !== undefined ? { model } : {})
      })
      return
    }
    case "UserPromptSubmit": {
      await post(`/sessions/${encoded}/status`, { status: "working" })
      const session = await getSessionInfo(encoded)
      if (!session) return
      if (session.bound === true) {
        writeMarker(id) // context is now in this conversation
        console.log(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: boundContext(session)
            }
          })
        )
      } else {
        clearMarker(id)
      }
      return
    }
    case "PostToolUse": {
      // Heartbeat: the agent just used a tool, so it is alive and working.
      await post(`/sessions/${encoded}/status`, { status: "working" })
      // Mid-task bind: if the human bound this session after the prompt was
      // submitted, inject the bound context here — once (marker-guarded),
      // not on every tool call. Unbind clears the marker so a re-bind
      // re-injects.
      const session = await getSessionInfo(encoded)
      if (!session) return
      if (session.bound !== true) {
        clearMarker(id)
        return
      }
      if (markerExists(id)) return
      writeMarker(id)
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: boundContext(session)
          }
        })
      )
      return
    }
    case "Stop":
      await post(`/sessions/${encoded}/status`, { status: "idle" })
      return
    case "Notification":
      await post(`/sessions/${encoded}/status`, { status: "needs-attention" })
      return
    case "SessionEnd":
      clearMarker(id)
      await post(`/sessions/${encoded}/end`)
      return
    default:
      return
  }
}

try {
  await main()
} catch {
  // Server down or slow — stay silent, never disturb the session.
}
process.exit(0)

export {}
