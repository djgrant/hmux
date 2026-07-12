import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  isServerEvent,
  type ServerEvent,
  type Session
} from "@hmux/protocol"

const PORT = 7912
const BASE = `http://localhost:${PORT}`
const DB = `${import.meta.dir}/.sessions-${Date.now()}.db`
const HOOK = `${import.meta.dir}/../../cc-plugin/src/hook.ts`
// Isolated bound-marker state dir so hook runs never touch the real ~/.hmux.
const STATE = `${import.meta.dir}/.hook-state-${Date.now()}`

let proc: Bun.Subprocess

beforeAll(async () => {
  proc = Bun.spawn(["bun", "run", `${import.meta.dir}/../src/index.ts`], {
    env: { ...process.env, HMUX_PORT: String(PORT), HMUX_DB: DB },
    stdout: "ignore",
    stderr: "inherit"
  })
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE)
      return
    } catch {
      await Bun.sleep(100)
    }
  }
  throw new Error("server did not start")
})

afterAll(() => {
  proc.kill()
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      require("fs").unlinkSync(DB + suffix)
    } catch {}
  }
  try {
    require("fs").rmSync(STATE, { recursive: true, force: true })
  } catch {}
})

const connectWs = () => {
  const events: ServerEvent[] = []
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
  ws.onmessage = (e) => {
    const parsed = JSON.parse(String(e.data))
    if (isServerEvent(parsed)) events.push(parsed)
  }
  return { ws, events, open: new Promise<void>((r) => (ws.onopen = () => r())) }
}

const waitFor = async <T>(get: () => T | undefined): Promise<T> => {
  for (let i = 0; i < 100; i++) {
    const value = get()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  throw new Error("timed out waiting for condition")
}

const getSession = async (id: string): Promise<Session> => {
  const res = await fetch(`${BASE}/sessions/${id}`)
  expect(res.ok).toBe(true)
  return (await res.json()) as Session
}

const runHook = async (input: Record<string, unknown>, env?: Record<string, string>) => {
  const hookProc = Bun.spawn(["bun", "run", HOOK], {
    // TMUX_PANE is cleared so hook runs never advertise onto the real pane
    // this test suite happens to run inside.
    env: { ...process.env, TMUX_PANE: "", HMUX_URL: BASE, HMUX_STATE_DIR: STATE, ...env },
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe"
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(hookProc.stdout).text(),
    new Response(hookProc.stderr).text(),
    hookProc.exited
  ])
  return { stdout, stderr, exitCode }
}

test("session lifecycle: register -> status -> bind via WS -> end", async () => {
  const { ws, events, open } = connectWs()
  await open
  const init = await waitFor(() => events.find((e) => e.type === "init"))
  expect(init.sessions).toEqual([])

  // Register
  const registerRes = await fetch(`${BASE}/sessions/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "sess-1",
      project: "/Users/me/code/hmux",
      model: "claude-fable-5"
    })
  })
  expect(registerRes.ok).toBe(true)
  const registered = (await registerRes.json()) as Session
  expect(registered.agent).toBe("hmux-sess")
  expect(registered.status).toBe("idle") // at its prompt until a prompt/tool says otherwise
  expect(registered.bound).toBe(false)

  const registeredEvent = await waitFor(() =>
    events.find(
      (e): e is Extract<ServerEvent, { type: "session.updated" }> =>
        e.type === "session.updated" && e.session.id === "sess-1"
    )
  )
  expect(registeredEvent.session.project).toBe("/Users/me/code/hmux")

  // Status update bumps lastSeen
  await Bun.sleep(5)
  const statusRes = await fetch(`${BASE}/sessions/sess-1/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "idle" })
  })
  expect(statusRes.ok).toBe(true)
  const idle = (await statusRes.json()) as Session
  expect(idle.status).toBe("idle")
  expect(idle.lastSeen).toBeGreaterThan(registered.lastSeen)

  // GET shows bound=false, bind over WS, GET shows bound=true
  expect((await getSession("sess-1")).bound).toBe(false)
  ws.send(JSON.stringify({ type: "bind", sessionId: "sess-1", bound: true }))
  const boundEvent = await waitFor(() =>
    events.find(
      (e): e is Extract<ServerEvent, { type: "session.updated" }> =>
        e.type === "session.updated" && e.session.id === "sess-1" && e.session.bound
    )
  )
  expect(boundEvent.session.bound).toBe(true)
  expect((await getSession("sess-1")).bound).toBe(true)

  // End
  const endRes = await fetch(`${BASE}/sessions/sess-1/end`, { method: "POST" })
  expect(endRes.ok).toBe(true)
  const ended = (await endRes.json()) as Session
  expect(ended.endedAt).toBeGreaterThan(0)
  expect(ended.bound).toBe(true) // bind survives end

  // New WS connections see the session in init
  const second = connectWs()
  await second.open
  const secondInit = await waitFor(() => second.events.find((e) => e.type === "init"))
  expect(secondInit.sessions.some((s) => s.id === "sess-1")).toBe(true)
  second.ws.close()
  ws.close()
}, 15_000)

test("unknown session ids are quietly upsert-registered on status and end", async () => {
  const statusRes = await fetch(`${BASE}/sessions/ghost-1/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "needs-attention" })
  })
  expect(statusRes.ok).toBe(true)
  const ghost = (await statusRes.json()) as Session
  expect(ghost.status).toBe("needs-attention")
  expect(ghost.agent).toBe("agent-ghos")

  const endRes = await fetch(`${BASE}/sessions/ghost-2/end`, { method: "POST" })
  expect(endRes.ok).toBe(true)
  expect(((await endRes.json()) as Session).endedAt).toBeGreaterThan(0)

  // Re-registering an ended session revives it but keeps startedAt/bound
  const reRes = await fetch(`${BASE}/sessions/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "ghost-2", project: "/tmp/proj" })
  })
  const revived = (await reRes.json()) as Session
  expect(revived.endedAt).toBeUndefined()
  expect(revived.project).toBe("/tmp/proj")
}, 15_000)

test("GET unknown session returns 404", async () => {
  const res = await fetch(`${BASE}/sessions/nope`)
  expect(res.status).toBe(404)
})

test("hook script drives the full lifecycle over stdin JSON", async () => {
  const id = "hook-sess-1"
  const cwd = "/Users/me/code/my-project"

  // SessionStart registers
  const start = await runHook({
    session_id: id,
    cwd,
    hook_event_name: "SessionStart",
    model: { id: "claude-fable-5", display_name: "Fable" }
  })
  expect(start.exitCode).toBe(0)
  expect(start.stdout).toBe("")
  let session = await getSession(id)
  expect(session.agent).toBe("my-project-hook")
  expect(session.project).toBe(cwd)
  expect(session.model).toBe("Fable")
  expect(session.status).toBe("idle") // freshly started = at the prompt

  // Stop -> idle
  const stop = await runHook({ session_id: id, cwd, hook_event_name: "Stop" })
  expect(stop.exitCode).toBe(0)
  const idled = await getSession(id)
  expect(idled.status).toBe("idle")

  // PostToolUse -> working heartbeat: status flips back and lastSeen bumps.
  await Bun.sleep(5)
  const heartbeat = await runHook({
    session_id: id,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Bash"
  })
  expect(heartbeat.exitCode).toBe(0)
  expect(heartbeat.stdout).toBe("") // heartbeats never emit hook output
  const beaten = await getSession(id)
  expect(beaten.status).toBe("working")
  expect(beaten.lastSeen).toBeGreaterThan(idled.lastSeen)

  // Notification: only permission wording means needs-attention; the ~60s
  // idle notification maps to idle; anything else leaves status untouched.
  await runHook({
    session_id: id,
    cwd,
    hook_event_name: "Notification",
    message: "Claude needs your permission to use Bash"
  })
  const attention = await getSession(id)
  expect(attention.status).toBe("needs-attention")
  expect(attention.detail).toBe("Claude needs your permission to use Bash") // roster label
  await runHook({
    session_id: id,
    cwd,
    hook_event_name: "Notification",
    message: "Claude is waiting for your input"
  })
  const idledByNotification = await getSession(id)
  expect(idledByNotification.status).toBe("idle")
  expect(idledByNotification.detail).toBeUndefined() // label cleared with the transition
  await runHook({ session_id: id, cwd, hook_event_name: "Notification", message: "Auth success" })
  expect((await getSession(id)).status).toBe("idle") // untouched
  await runHook({ session_id: id, cwd, hook_event_name: "Notification" }) // no message field
  expect((await getSession(id)).status).toBe("idle") // untouched

  // UserPromptSubmit -> working; not bound, so no output
  const promptUnbound = await runHook({
    session_id: id,
    cwd,
    hook_event_name: "UserPromptSubmit",
    prompt: "hello"
  })
  expect(promptUnbound.exitCode).toBe(0)
  expect(promptUnbound.stdout).toBe("")
  expect((await getSession(id)).status).toBe("working")

  // Bind, then UserPromptSubmit injects additionalContext
  const { ws, open } = connectWs()
  await open
  ws.send(JSON.stringify({ type: "bind", sessionId: id, bound: true }))
  for (let i = 0; i < 100 && !(await getSession(id)).bound; i++) await Bun.sleep(50)
  expect((await getSession(id)).bound).toBe(true)
  ws.close()

  const promptBound = await runHook({
    session_id: id,
    cwd,
    hook_event_name: "UserPromptSubmit",
    prompt: "hello again"
  })
  expect(promptBound.exitCode).toBe(0)
  const output = JSON.parse(promptBound.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string }
  }
  expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
  expect(output.hookSpecificOutput.additionalContext).toContain("mcp__hmux__ask")
  expect(output.hookSpecificOutput.additionalContext).toContain("mcp__hmux__notify")

  // PreToolUse on an hmux tool: the harness session id is stamped into the
  // tool input, overriding a model-supplied (spoofed) sessionId.
  const preTool = await runHook({
    session_id: id,
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "mcp__hmux__notify",
    tool_input: { message: "hi", sessionId: "spoofed-session" }
  })
  expect(preTool.exitCode).toBe(0)
  const stamped = JSON.parse(preTool.stdout) as {
    hookSpecificOutput: { hookEventName: string; updatedInput: Record<string, unknown> }
  }
  expect(stamped.hookSpecificOutput.hookEventName).toBe("PreToolUse")
  expect(stamped.hookSpecificOutput.updatedInput.sessionId).toBe(id)
  expect(stamped.hookSpecificOutput.updatedInput.message).toBe("hi")

  // PreToolUse on any other tool: silent.
  const preOther = await runHook({
    session_id: id,
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" }
  })
  expect(preOther.stdout).toBe("")

  // PostToolUse while bound: UserPromptSubmit already injected the context
  // into this conversation (marker file), so no duplicate.
  const postDup = await runHook({ session_id: id, cwd, hook_event_name: "PostToolUse" })
  expect(postDup.exitCode).toBe(0)
  expect(postDup.stdout).toBe("")

  // Unbind → PostToolUse stays silent and clears the marker.
  const ws2 = connectWs()
  await ws2.open
  ws2.ws.send(JSON.stringify({ type: "bind", sessionId: id, bound: false }))
  for (let i = 0; i < 100 && (await getSession(id)).bound; i++) await Bun.sleep(50)
  const postUnbound = await runHook({ session_id: id, cwd, hook_event_name: "PostToolUse" })
  expect(postUnbound.stdout).toBe("")

  // Re-bind mid-task → the NEXT tool call injects once, via PostToolUse
  // hookSpecificOutput; the one after stays silent.
  ws2.ws.send(JSON.stringify({ type: "bind", sessionId: id, bound: true }))
  for (let i = 0; i < 100 && !(await getSession(id)).bound; i++) await Bun.sleep(50)
  ws2.ws.close()
  const postRebound = await runHook({ session_id: id, cwd, hook_event_name: "PostToolUse" })
  const reOut = JSON.parse(postRebound.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string }
  }
  expect(reOut.hookSpecificOutput.hookEventName).toBe("PostToolUse")
  expect(reOut.hookSpecificOutput.additionalContext).toContain("mcp__hmux__ask")
  const postAgain = await runHook({ session_id: id, cwd, hook_event_name: "PostToolUse" })
  expect(postAgain.stdout).toBe("")

  // SessionEnd
  const end = await runHook({ session_id: id, cwd, hook_event_name: "SessionEnd" })
  expect(end.exitCode).toBe(0)
  expect((await getSession(id)).endedAt).toBeGreaterThan(0)
}, 20_000)

test("needs-attention is a roster label: detail stored, cleared, never a queue message", async () => {
  const { ws, events, open } = connectWs()
  await open
  await fetch(`${BASE}/sessions/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "na-1", agent: "na-bot", project: "/tmp/na-project" })
  })
  const setStatus = (status: string, detail?: string) =>
    fetch(`${BASE}/sessions/na-1/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, ...(detail !== undefined ? { detail } : {}) })
    })

  // needs-attention stores the reason and broadcasts it on the session.
  await setStatus("needs-attention", "Claude needs your permission to use Bash")
  const blocked = await getSession("na-1")
  expect(blocked.status).toBe("needs-attention")
  expect(blocked.detail).toBe("Claude needs your permission to use Bash")
  const updated = await waitFor(() =>
    events.find(
      (e): e is Extract<ServerEvent, { type: "session.updated" }> =>
        e.type === "session.updated" && e.session.id === "na-1" && e.session.detail !== undefined
    )
  )
  expect(updated.session.detail).toContain("permission")

  // Transitioning away clears the label.
  await setStatus("working")
  expect((await getSession("na-1")).detail).toBeUndefined()

  // needs-attention without a detail: label absent, still no crash.
  await setStatus("needs-attention")
  expect((await getSession("na-1")).detail).toBeUndefined()

  // Blocked sessions NEVER publish queue messages (round-15 behaviour removed).
  await Bun.sleep(300)
  expect(events.some((e) => e.type === "message.new" && e.message.agent === "na-bot")).toBe(false)
  ws.close()
}, 15_000)

test("a declared signal shapes the Stop status and survives the idle notification", async () => {
  const id = "hook-sig-1"
  const cwd = "/Users/me/code/my-project"
  await runHook({ session_id: id, cwd, hook_event_name: "SessionStart" })

  // signal(question) → Stop promotes it to needs-attention with a label.
  const pre = await runHook({
    session_id: id,
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "mcp__hmux__signal",
    tool_input: { status: "question" }
  })
  expect(pre.exitCode).toBe(0)
  const stamped = JSON.parse(pre.stdout) as {
    hookSpecificOutput: { updatedInput: Record<string, unknown> }
  }
  expect(stamped.hookSpecificOutput.updatedInput.sessionId).toBe(id) // stamp still applies
  await runHook({ session_id: id, cwd, hook_event_name: "Stop" })
  const asked = await getSession(id)
  expect(asked.status).toBe("needs-attention")
  expect(asked.detail).toContain("question")

  // The ~60s idle notification must not stomp the declared label.
  await runHook({
    session_id: id,
    cwd,
    hook_event_name: "Notification",
    message: "Claude is waiting for your input"
  })
  expect((await getSession(id)).status).toBe("needs-attention")

  // The human replying spends the signal: the next Stop is a plain idle.
  await runHook({ session_id: id, cwd, hook_event_name: "UserPromptSubmit", prompt: "answer" })
  expect((await getSession(id)).status).toBe("working")
  await runHook({ session_id: id, cwd, hook_event_name: "Stop" })
  const plain = await getSession(id)
  expect(plain.status).toBe("idle")
  expect(plain.detail).toBeUndefined()

  // signal(done) → Stop maps to idle (the distinction lives in the hmux plane).
  await runHook({ session_id: id, cwd, hook_event_name: "UserPromptSubmit", prompt: "go" })
  await runHook({
    session_id: id,
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "mcp__hmux__signal",
    tool_input: { status: "done" }
  })
  await runHook({ session_id: id, cwd, hook_event_name: "Stop" })
  expect((await getSession(id)).status).toBe("idle")

  await runHook({ session_id: id, cwd, hook_event_name: "SessionEnd" })
}, 20_000)

test("hook script is silent and exits 0 when the server is down", async () => {
  const result = await runHook(
    { session_id: "down-1", cwd: "/tmp", hook_event_name: "SessionStart" },
    { HMUX_URL: "http://localhost:1" }
  )
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe("")
  expect(result.stderr).toBe("")
}, 15_000)

test("hook script exits 0 on garbage stdin", async () => {
  const result = await runHook({} as Record<string, unknown>)
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe("")
})
