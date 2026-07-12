/**
 * hmux Claude Code hook. One script for all six events, dispatched on
 * hook_event_name from the stdin JSON:
 *
 *   SessionStart     -> POST /sessions/register   (project = cwd, agent = dirname/branch-<id prefix>)
 *   PreToolUse       -> mcp__hmux__* calls only: stamp the harness-provided
 *                       session id into the tool input (updatedInput), making
 *                       message attribution harness-asserted, not model-asserted.
 *                       Also the hmux listening post: ask/approve advertise a
 *                       message label for the duration of the block, and
 *                       signal stashes a turn-end declaration for Stop
 *   UserPromptSubmit -> POST /sessions/:id/status {status: "working"}
 *                       + GET /sessions/:id; if bound, emit additionalContext
 *   PostToolUse      -> POST /sessions/:id/status {status: "working"}   (heartbeat)
 *                       + GET /sessions/:id; if bound and not yet injected
 *                       this session (marker file), emit additionalContext
 *   Stop             -> promotes a declared signal (question -> needs-attention,
 *                       done -> idle "done"), else {status: "idle"}
 *   Notification     -> POST /sessions/:id/status — "needs-attention" only
 *                       for permission prompts; the idle "waiting for your
 *                       input" notification maps to "idle"; others no-op
 *   SessionEnd       -> POST /sessions/:id/end (+ clear marker)
 *
 * PostToolUse is the heartbeat: every status call bumps last_seen on the
 * server, so an actively-working agent stays fresh in the mailbox roster. A
 * session sitting idle at the prompt fires no periodic hook and genuinely
 * cannot heartbeat — the mailbox renders it as stale-but-listed instead.
 * PostToolUse also picks up MID-TASK binds: the human can bind a session
 * while it works, and the very next tool call injects the bound context.
 *
 * A hook must never break a Claude Code session: every fetch has a short
 * timeout and every failure path exits 0 with no output.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const BASE = process.env.HMUX_URL ?? "http://localhost:7373"
const FETCH_TIMEOUT_MS = 2000

// Marker files make the PostToolUse context injection cheap-idempotent: the
// marker exists while the bound context has already been injected into THIS
// session. Cleared on SessionStart (fresh conversation), on unbind (so a
// re-bind re-injects), and on SessionEnd. All operations are failure-silent.
const STATE_DIR = process.env.HMUX_STATE_DIR ?? join(homedir(), ".hmux")
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

// Signal markers carry a turn-end declaration (mcp__hmux__signal) from the
// PreToolUse that saw the call to the Stop that ends the turn. The marker
// outlives Stop on purpose — the ~60s idle Notification must not stomp the
// declared label — and is cleared when the human acts (UserPromptSubmit) or
// the conversation resets (SessionStart/SessionEnd).
const signalPath = (id: string) => join(STATE_DIR, `signal-${encodeURIComponent(id)}`)
const readSignal = (id: string): string | undefined => {
  try {
    const value = readFileSync(signalPath(id), "utf8").trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}
const writeSignal = (id: string, status: string) => {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(signalPath(id), status)
  } catch {}
}
const clearSignal = (id: string) => {
  try {
    rmSync(signalPath(id), { force: true })
  } catch {}
}

interface HookInput {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  model?: unknown
  /** SessionStart events: "startup" | "resume" | "clear" | "compact". */
  source?: unknown
  /** Notification events: the notification text. */
  message?: unknown
  /** PreToolUse events: the tool being called and its input. */
  tool_name?: unknown
  tool_input?: unknown
}

interface SessionInfo {
  bound?: boolean
  agent?: string
  project?: string
}

/**
 * Advertise via `hmux advertise` — hmux's signal plane, independent of the
 * hmux server. The hook runs inside the pane, so hmux knows exactly which
 * pane is speaking; where the state is stored is hmux's backend's business.
 * Status vocabulary is hmux's ("who needs me"): error > message (the agent
 * left the human something; detail says what) > busy > idle. An unsignalled
 * finished turn is idle — only declared states claim attention. A resume
 * command, advertised at session start, lets hmux relaunch this session when
 * it restores after a reboot. Failure-silent like everything else, including
 * when hmux is not installed.
 */
const advertise = (
  status: string | null,
  detail?: string,
  agent?: string | null,
  resume?: string,
) => {
  const args =
    status === null
      ? ["--clear"]
      : [
          ...["--status", status],
          ...(detail !== undefined ? ["--detail", detail] : []),
          ...(agent !== undefined && agent !== null ? ["--agent", agent] : []),
          ...(resume !== undefined ? ["--resume", resume] : []),
        ]
  try {
    Bun.spawnSync(["hmux", "advertise", ...args], { stdout: "ignore", stderr: "ignore" })
  } catch {}
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

// Current git branch of cwd, or undefined outside a repo / on any failure.
const gitBranch = (cwd: string): string | undefined => {
  try {
    const proc = Bun.spawnSync(["git", "-C", cwd, "branch", "--show-current"], {
      stdout: "pipe",
      stderr: "ignore"
    })
    const branch = proc.stdout.toString().trim()
    return proc.exitCode === 0 && branch.length > 0 ? branch : undefined
  } catch {
    return undefined
  }
}

const modelName = (model: unknown): string | undefined => {
  if (typeof model === "string") return model
  if (typeof model === "object" && model !== null) {
    const m = model as Record<string, unknown>
    if (typeof m.display_name === "string") return m.display_name
    if (typeof m.id === "string") return m.id
  }
  return undefined
}

// Identity is handled by the PreToolUse stamp (the harness-provided session
// id is written into every hmux tool call), so the injected context only
// needs to teach the workflow — no self-declared names to keep honest.
const boundContext = (_session: SessionInfo): string =>
  "This session is bound to a human inbox via hmux. When you need a decision, " +
  "clarification, or approval, ask the human with the mcp__hmux__ask tool instead of " +
  "guessing. Send progress updates and completions with mcp__hmux__notify. Just before " +
  "ending a turn, declare how it ends with mcp__hmux__signal: status 'question' when your " +
  "response asks the human something, 'done' when the work is complete."

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
      const branch = cwd !== undefined ? gitBranch(cwd) : undefined
      const name =
        dirname !== undefined
          ? `${dirname}${branch !== undefined ? `/${branch}` : ""}-${id.slice(0, 4)}`
          : undefined
      const model = modelName(input.model)
      // Fresh conversation: whatever context an earlier run injected is gone,
      // so clear the marker and let the next bound check re-inject.
      clearMarker(id)
      clearSignal(id)
      // A session that just started is sitting at its prompt — idle, not
      // busy. The exception is source=compact, which fires mid-turn while
      // the agent is actively working.
      const atRest = input.source !== "compact"
      advertise(
        atRest ? "idle" : "busy",
        undefined,
        [`${dirname ?? "claude"}-${id.slice(0, 4)}`, model].filter(Boolean).join(" · "),
        `claude --resume ${id}`,
      )
      await post("/sessions/register", {
        id,
        ...(name !== undefined ? { agent: name } : {}),
        ...(cwd !== undefined ? { project: cwd } : {}),
        ...(model !== undefined ? { model } : {})
      })
      return
    }
    case "PreToolUse": {
      // Identity stamp: write THIS session's harness-provided id into every
      // hmux tool call, overriding whatever the model put there. The server
      // treats a registered sessionId as authoritative for agent/project, so
      // an agent cannot impersonate another by lying in tool params.
      if (typeof input.tool_name !== "string" || !input.tool_name.startsWith("mcp__hmux__")) {
        return
      }
      const toolInput =
        typeof input.tool_input === "object" && input.tool_input !== null
          ? (input.tool_input as Record<string, unknown>)
          : {}
      // The hmux tools declare intent, so advertise it live. ask/approve
      // block until the human responds and no other hook fires meanwhile, so
      // the label set here holds for the whole wait; PostToolUse returns the
      // pane to busy when the call resolves. signal is a turn-end declaration:
      // stash it for Stop to promote.
      if (input.tool_name === "mcp__hmux__ask") {
        const q = typeof toolInput.question === "string" ? toolInput.question : ""
        advertise("message", q ? `asks: ${q.trim().slice(0, 120)}` : "needs decision")
      } else if (input.tool_name === "mcp__hmux__approve") {
        advertise("message", "approval requested")
      } else if (input.tool_name === "mcp__hmux__signal") {
        if (typeof toolInput.status === "string") writeSignal(id, toolInput.status)
      }
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: { ...toolInput, sessionId: id }
          }
        })
      )
      return
    }
    case "UserPromptSubmit": {
      clearSignal(id) // the human has acted; the declared turn-end label is spent
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
    case "Stop": {
      // A declared signal (mcp__hmux__signal) ends the turn as a message —
      // the agent left the human something, the detail says what. An
      // unsignalled stop honestly doesn't know whether the human is needed,
      // so it rests at idle rather than faking urgency.
      const signal = readSignal(id)
      if (signal === "question") {
        advertise("message", "needs direction")
        await post(`/sessions/${encoded}/status`, {
          status: "needs-attention",
          detail: "asked a question — see chat"
        })
      } else if (signal === "done") {
        advertise("message", "done")
        await post(`/sessions/${encoded}/status`, { status: "idle" })
      } else {
        advertise("idle")
        await post(`/sessions/${encoded}/status`, { status: "idle" })
      }
      return
    }
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
        advertise("message", text.trim().slice(0, 200))
        await post(`/sessions/${encoded}/status`, {
          status: "needs-attention",
          detail: text.trim().slice(0, 200)
        })
      } else if (/waiting for your input/i.test(text)) {
        // A declared turn-end signal outranks the generic idle rewrite.
        if (readSignal(id) === undefined) {
          advertise("idle")
          await post(`/sessions/${encoded}/status`, { status: "idle" })
        }
      }
      return
    }
    case "SessionEnd":
      clearMarker(id)
      clearSignal(id)
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
