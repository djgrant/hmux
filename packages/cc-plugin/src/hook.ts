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
 *   Notification     -> POST /sessions/:id/status — "needs-attention" only
 *                       for permission prompts; the idle "waiting for your
 *                       input" notification maps to "idle"; others no-op
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
  /** Notification events: the notification text. */
  message?: unknown
}

interface SessionInfo {
  bound?: boolean
  agent?: string
  project?: string
}

/**
 * Advertise into tmux pane user options (the mux advertise protocol) — the
 * hook runs inside the pane, so $TMUX_PANE identifies it exactly. This is a
 * second, server-independent signal plane: mux reads it straight off tmux.
 * Status semantics here are mux's ("who needs me"), not the roster's — a
 * finished turn is `waiting`, not `idle`. Failure-silent like everything else.
 */
const advertise = (status: string | null, detail?: string, agent?: string | null) => {
  const pane = process.env.TMUX_PANE
  if (!pane) return
  const set = (option: string, value: string | null | undefined) => {
    try {
      if (value === undefined) return
      const args =
        value === null
          ? ["set-option", "-pu", "-t", pane, option]
          : ["set-option", "-p", "-t", pane, option, value]
      Bun.spawnSync(["tmux", ...args], { stdout: "ignore", stderr: "ignore" })
    } catch {}
  }
  set("@humans_status", status)
  set("@humans_detail", detail === undefined ? null : detail)
  if (agent !== undefined) set("@humans_agent", agent)
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
      advertise("busy", undefined, [`${dirname ?? "claude"}-${id.slice(0, 4)}`, model].filter(Boolean).join(" · "))
      await post("/sessions/register", {
        id,
        ...(dirname !== undefined ? { agent: `${dirname}-${id.slice(0, 4)}` } : {}),
        ...(cwd !== undefined ? { project: cwd } : {}),
        ...(model !== undefined ? { model } : {})
      })
      return
    }
    case "UserPromptSubmit": {
      advertise("busy")
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
      advertise("busy")
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
      // Roster semantics: idle. mux semantics: the turn ended, a human is
      // needed to move things forward.
      advertise("waiting", "awaiting your reply")
      await post(`/sessions/${encoded}/status`, { status: "idle" })
      return
    case "Notification": {
      // Notification fires for MORE than permission prompts — notably the
      // "Claude is waiting for your input" idle notification (~60s after
      // the session idles) and auth/elicitation events. Only a genuine
      // attention case may set needs-attention (it renders as a "blocked"
      // roster label with the reason); the idle notification maps to idle,
      // and unknown notification kinds leave the status untouched.
      const text = typeof input.message === "string" ? input.message : ""
      if (/permission/i.test(text)) {
        // The notification text rides along as the roster "blocked" label.
        advertise("waiting", text.trim().slice(0, 200))
        await post(`/sessions/${encoded}/status`, {
          status: "needs-attention",
          detail: text.trim().slice(0, 200)
        })
      } else if (/waiting for your input/i.test(text)) {
        advertise("waiting", "waiting for your input")
        await post(`/sessions/${encoded}/status`, { status: "idle" })
      }
      return
    }
    case "SessionEnd":
      clearMarker(id)
      advertise(null, undefined, null)
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
