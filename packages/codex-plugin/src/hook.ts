/** Codex lifecycle bridge for hmux. Every failure is intentionally silent. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { execFileSync, spawnSync } from "node:child_process"

const BASE = process.env.HMUX_URL ?? "http://localhost:7373"
const TOOL_PREFIX = "mcp__hmux__"
const STATE_DIR = process.env.HMUX_STATE_DIR ?? join(homedir(), ".hmux")
const FETCH_TIMEOUT_MS = 2_000

interface HookInput {
  session_id?: unknown
  cwd?: unknown
  hook_event_name?: unknown
  source?: unknown
  model?: unknown
  transcript_path?: unknown
  tool_name?: unknown
  tool_input?: unknown
  agent_id?: unknown
  agent_type?: unknown
}

interface SessionInfo {
  bound?: boolean
}

const statePath = (kind: "bound" | "signal", id: string) =>
  join(STATE_DIR, `${kind}-${encodeURIComponent(id)}`)

const readState = (kind: "bound" | "signal", id: string): string | undefined => {
  try {
    const value = readFileSync(statePath(kind, id), "utf8").trim()
    return value || undefined
  } catch {
    return undefined
  }
}

const writeState = (kind: "bound" | "signal", id: string, value = "1") => {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(statePath(kind, id), value)
  } catch {}
}

const clearState = (kind: "bound" | "signal", id: string) => {
  try {
    rmSync(statePath(kind, id), { force: true })
  } catch {}
}

const post = (path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  })

const sessionInfo = async (id: string): Promise<SessionInfo | undefined> => {
  try {
    const response = await fetch(`${BASE}/sessions/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    return response.ok ? ((await response.json()) as SessionInfo) : undefined
  } catch {
    return undefined
  }
}

const advertise = (fields: {
  status: "idle" | "busy" | "message"
  detail?: string
  agent?: string
  resume?: string
  transcript?: string
}) => {
  const args = [
    "advertise",
    "--status",
    fields.status,
    ...(fields.detail === undefined ? [] : ["--detail", fields.detail]),
    ...(fields.agent === undefined ? [] : ["--agent", fields.agent]),
    ...(fields.resume === undefined ? [] : ["--resume", fields.resume]),
    ...(fields.transcript === undefined ? [] : ["--transcript", fields.transcript])
  ]
  try {
    spawnSync("hmux", args, { stdio: "ignore" })
  } catch {}
}

const clearAdvertise = () => {
  try {
    spawnSync("hmux", ["advertise", "--clear"], { stdio: "ignore" })
  } catch {}
}

const gitBranch = (cwd: string): string | undefined => {
  try {
    const branch = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .trim()
    return branch || undefined
  } catch {
    return undefined
  }
}

const output = (event: string, value: Record<string, unknown>) => {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...value } }))
}

const boundContext =
  "This session is bound to a human inbox via hmux. When you need a decision, " +
  `clarification, or approval, ask the human with ${TOOL_PREFIX}ask instead of guessing. ` +
  `Send progress updates and completions with ${TOOL_PREFIX}notify. Just before ending a ` +
  `turn, call ${TOOL_PREFIX}signal with status 'question' when your response asks the human ` +
  "something, or 'done' when the work is complete."

const isSubagent = (input: HookInput) =>
  [input.agent_id, input.agent_type].some(
    (value) => typeof value === "string" && value.length > 0
  )

const main = async () => {
  let input: HookInput
  try {
    input = JSON.parse(await Bun.stdin.text()) as HookInput
  } catch {
    return
  }

  if (typeof input.session_id !== "string" || input.session_id.length === 0) return
  const id = input.session_id
  const encoded = encodeURIComponent(id)

  switch (input.hook_event_name) {
    case "SessionStart": {
      clearState("bound", id)
      clearState("signal", id)
      const cwd = typeof input.cwd === "string" ? input.cwd : undefined
      const dir = cwd === undefined ? "codex" : basename(cwd)
      const branch = cwd === undefined ? undefined : gitBranch(cwd)
      const model = typeof input.model === "string" ? input.model : undefined
      advertise({
        status: input.source === "compact" ? "busy" : "idle",
        agent: [`${dir}-${id.slice(0, 4)}`, model].filter(Boolean).join(" · "),
        resume: `codex resume ${id}`,
        ...(typeof input.transcript_path === "string"
          ? { transcript: input.transcript_path }
          : {})
      })
      await post("/sessions/register", {
        id,
        agent: `${dir}${branch === undefined ? "" : `/${branch}`}-${id.slice(0, 4)}`,
        ...(cwd === undefined ? {} : { project: cwd }),
        ...(model === undefined ? {} : { model })
      })
      return
    }

    case "UserPromptSubmit": {
      clearState("signal", id)
      advertise({ status: "busy" })
      await post(`/sessions/${encoded}/status`, { status: "working" })
      const session = await sessionInfo(id)
      if (session?.bound === true) {
        writeState("bound", id)
        output("UserPromptSubmit", { additionalContext: boundContext })
      } else {
        clearState("bound", id)
      }
      return
    }

    case "PreToolUse": {
      if (typeof input.tool_name !== "string" || !input.tool_name.startsWith(TOOL_PREFIX)) return
      const tool = input.tool_name.slice(TOOL_PREFIX.length)
      const toolInput =
        typeof input.tool_input === "object" && input.tool_input !== null
          ? (input.tool_input as Record<string, unknown>)
          : {}
      if (tool === "ask") {
        const question = typeof toolInput.question === "string" ? toolInput.question.trim() : ""
        advertise({
          status: "message",
          detail: question ? `asks: ${question.slice(0, 120)}` : "needs decision"
        })
      } else if (tool === "approve") {
        advertise({ status: "message", detail: "approval requested" })
      } else if (tool === "signal" && typeof toolInput.status === "string") {
        writeState("signal", id, toolInput.status)
      }
      output("PreToolUse", { updatedInput: { ...toolInput, sessionId: id } })
      return
    }

    case "PostToolUse": {
      advertise({ status: "busy" })
      await post(`/sessions/${encoded}/status`, { status: "working" })
      if (isSubagent(input)) return
      const session = await sessionInfo(id)
      if (session?.bound !== true) {
        clearState("bound", id)
      } else if (readState("bound", id) === undefined) {
        writeState("bound", id)
        output("PostToolUse", { additionalContext: boundContext })
      }
      return
    }

    case "SubagentStop":
      advertise({ status: "busy" })
      await post(`/sessions/${encoded}/status`, { status: "working" })
      return

    case "Stop": {
      if (isSubagent(input)) {
        advertise({ status: "busy" })
        await post(`/sessions/${encoded}/status`, { status: "working" })
        return
      }
      const signal = readState("signal", id)
      if (signal === "question") {
        advertise({ status: "message", detail: "needs direction" })
        await post(`/sessions/${encoded}/status`, {
          status: "needs-attention",
          detail: "asked a question — see chat"
        })
      } else if (signal === "done") {
        advertise({ status: "message", detail: "done" })
        await post(`/sessions/${encoded}/status`, { status: "idle" })
      } else {
        advertise({ status: "idle" })
        await post(`/sessions/${encoded}/status`, { status: "idle" })
      }
      return
    }

    case "SessionEnd": {
      clearState("bound", id)
      clearState("signal", id)
      clearAdvertise()
      await post(`/sessions/${encoded}/end`)
    }
  }
}

try {
  await main()
} catch {}

process.exit(0)
export {}
