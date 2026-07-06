/**
 * humans.sh Claude Code hook. One script for all five events, dispatched on
 * hook_event_name from the stdin JSON:
 *
 *   SessionStart     -> POST /sessions/register   (project = cwd, agent = dirname-<id prefix>)
 *   UserPromptSubmit -> POST /sessions/:id/status {status: "working"}
 *                       + GET /sessions/:id; if bound, emit additionalContext
 *   Stop             -> POST /sessions/:id/status {status: "idle"}
 *   Notification     -> POST /sessions/:id/status {status: "needs-attention"}
 *   SessionEnd       -> POST /sessions/:id/end
 *
 * A hook must never break a Claude Code session: every fetch has a short
 * timeout and every failure path exits 0 with no output.
 */

const BASE = process.env.HUMANS_URL ?? "http://localhost:7373"
const FETCH_TIMEOUT_MS = 2000

interface HookInput {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  model?: unknown
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

const BOUND_CONTEXT =
  "This session is bound to a human inbox via humans.sh. When you need a decision, " +
  "clarification, or approval, ask the human with the mcp__humans__ask tool instead of " +
  "guessing. Send progress updates and completions with mcp__humans__notify."

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
      const res = await request(`/sessions/${encoded}`)
      if (!res.ok) return
      const session = (await res.json()) as { bound?: boolean }
      if (session.bound === true) {
        console.log(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: BOUND_CONTEXT
            }
          })
        )
      }
      return
    }
    case "Stop":
      await post(`/sessions/${encoded}/status`, { status: "idle" })
      return
    case "Notification":
      await post(`/sessions/${encoded}/status`, { status: "needs-attention" })
      return
    case "SessionEnd":
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
