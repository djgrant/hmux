import { afterAll, beforeAll, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  isServerEvent,
  type Message,
  type ServerEvent
} from "@hmux/protocol"

const PORT = 7911
const BASE = `http://localhost:${PORT}`
const DB = `${import.meta.dir}/.e2e-${Date.now()}.db`

let proc: Bun.Subprocess

beforeAll(async () => {
  proc = Bun.spawn(["bun", "run", `${import.meta.dir}/../src/index.ts`], {
    env: {
      ...process.env,
      HMUX_PORT: String(PORT),
      HMUX_DB: DB,
      // Fast keep-alive ticks so the blocked-tool session-touch is testable.
      HUMANS_PROGRESS_INTERVAL_MS: "100"
    },
    stdout: "ignore",
    stderr: "inherit"
  })
  // Wait for the server to accept connections
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
})

const connectMcp = async (headers?: Record<string, string>) => {
  const client = new Client({ name: "e2e", version: "0.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${BASE}/mcp`),
      headers ? { requestInit: { headers } } : undefined
    )
  )
  return client
}

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

test("ask blocks until answered via WS, then returns the answer", async () => {
  const { ws, events, open } = connectWs()
  await open

  // WS gets an init frame on connect
  const init = await waitFor(() => events.find((e) => e.type === "init"))
  expect(init.type).toBe("init")

  const client = await connectMcp()
  const askResult = client.callTool({
    name: "ask",
    arguments: {
      question: "Ship it?",
      context: "e2e test",
      agent: "e2e-agent",
      project: "hmux"
    }
  })

  // The pending ask is broadcast to WS clients
  const created = await waitFor(() =>
    events.find(
      (e): e is Extract<ServerEvent, { type: "message.new" }> =>
        e.type === "message.new" && e.message.body === "Ship it?"
    )
  )
  const message: Message = created.message
  expect(message.kind).toBe("ask")
  expect(message.status).toBe("pending")
  expect(message.agent).toBe("e2e-agent")

  // Human answers over WS
  ws.send(JSON.stringify({ type: "answer", id: message.id, text: "Yes, ship it" }))

  const answered = await waitFor(() =>
    events.find((e) => e.type === "message.answered" && e.id === message.id)
  )
  expect(answered.type).toBe("message.answered")

  // The blocked MCP ask call resolves with the human's answer
  const result = (await askResult) as { content: Array<{ type: string; text: string }> }
  expect(result.content[0]?.text).toBe("Yes, ship it")

  // Answer is idempotent: a second answer changes nothing and re-broadcasts nothing
  const before = events.filter((e) => e.type === "message.answered").length
  ws.send(JSON.stringify({ type: "answer", id: message.id, text: "changed my mind" }))
  await Bun.sleep(300)
  expect(events.filter((e) => e.type === "message.answered").length).toBe(before)

  await client.close()
  ws.close()
}, 15_000)

test("approve blocks, then returns the permission-result JSON (allow and deny)", async () => {
  const { ws, events, open } = connectWs()
  await open
  const client = await connectMcp()

  // Allow path: "allow" answers with behavior=allow + the ORIGINAL input.
  const allowCall = client.callTool({
    name: "approve",
    arguments: {
      tool_name: "Bash",
      input: { command: "rm -rf dist" },
      tool_use_id: "tu-1",
      agent: "e2e-agent",
      project: "hmux"
    }
  })
  const created = await waitFor(() =>
    events.find(
      (e): e is Extract<ServerEvent, { type: "message.new" }> =>
        e.type === "message.new" && e.message.kind === "approval"
    )
  )
  expect(created.message.body).toContain("wants to run Bash")
  expect(created.message.body).toContain("rm -rf dist")
  expect(created.message.suggestion).toBe("allow") // the mailbox ghost
  ws.send(JSON.stringify({ type: "answer", id: created.message.id, text: "allow" }))
  const allowResult = (await allowCall) as { content: Array<{ type: string; text: string }> }
  expect(JSON.parse(allowResult.content[0]!.text)).toEqual({
    behavior: "allow",
    updatedInput: { command: "rm -rf dist" }
  })

  // Deny path: any other text denies, with the text as the reason.
  const denyCall = client.callTool({
    name: "approve",
    arguments: { tool_name: "Edit", input: { file_path: "/etc/hosts" }, agent: "e2e-agent" }
  })
  const denyMsg = await waitFor(() =>
    events.find(
      (e): e is Extract<ServerEvent, { type: "message.new" }> =>
        e.type === "message.new" && e.message.kind === "approval" && e.message.body.includes("Edit")
    )
  )
  ws.send(JSON.stringify({ type: "answer", id: denyMsg.message.id, text: "not on this host" }))
  const denyResult = (await denyCall) as { content: Array<{ type: string; text: string }> }
  expect(JSON.parse(denyResult.content[0]!.text)).toEqual({
    behavior: "deny",
    message: "not on this host"
  })

  await client.close()
  ws.close()
}, 15_000)

test("identity headers default agent/project; args win; session header resolves + touches", async () => {
  const { ws, events, open } = connectWs()
  await open

  // Header identity as the default: approve without agent/project args
  // (exactly how Claude Code's own permission-tool invocation arrives).
  const c1 = await connectMcp({ "x-hmux-agent": "hdr-bot", "x-hmux-project": "hdr-proj" })
  const approveCall = c1.callTool({
    name: "approve",
    arguments: { tool_name: "Bash", input: { command: "make" } }
  })
  const approval = await waitFor(() =>
    events.find(
      (e): e is Extract<ServerEvent, { type: "message.new" }> =>
        e.type === "message.new" && e.message.kind === "approval" && e.message.agent === "hdr-bot"
    )
  )
  expect(approval.message.project).toBe("hdr-proj")
  ws.send(JSON.stringify({ type: "answer", id: approval.message.id, text: "allow" }))
  await approveCall

  // Tool args always win over headers.
  await c1.callTool({
    name: "notify",
    arguments: { message: "args win", agent: "arg-bot", project: "arg-proj" }
  })
  const argsWin = await waitFor(() =>
    events.find(
      (e): e is Extract<ServerEvent, { type: "message.new" }> =>
        e.type === "message.new" && e.message.body === "args win"
    )
  )
  expect(argsWin.message.agent).toBe("arg-bot")
  expect(argsWin.message.project).toBe("arg-proj")
  await c1.close()

  // Session header: the registered identity is authoritative (beats the
  // agent header) and each tool call bumps the session's lastSeen.
  const regRes = await fetch(`${BASE}/sessions/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "hdr-sess", agent: "reg-bot", project: "/reg/proj" })
  })
  const before = ((await regRes.json()) as { lastSeen: number }).lastSeen
  await Bun.sleep(5)
  const c2 = await connectMcp({ "x-hmux-session": "hdr-sess", "x-hmux-agent": "ignored-bot" })
  await c2.callTool({ name: "notify", arguments: { message: "sess notify" } })
  const sessMsg = await waitFor(() =>
    events.find(
      (e): e is Extract<ServerEvent, { type: "message.new" }> =>
        e.type === "message.new" && e.message.body === "sess notify"
    )
  )
  expect(sessMsg.message.agent).toBe("reg-bot")
  expect(sessMsg.message.project).toBe("/reg/proj")
  const touched = (await (await fetch(`${BASE}/sessions/hdr-sess`)).json()) as {
    lastSeen: number
  }
  expect(touched.lastSeen).toBeGreaterThan(before)
  await c2.close()
  ws.close()
}, 15_000)

test("a blocked tool call keeps the matching session's lastSeen fresh", async () => {
  // Session with the same roster identity the tool call will carry.
  const registerRes = await fetch(`${BASE}/sessions/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "touch-1", agent: "touch-agent", project: "hmux" })
  })
  const before = ((await registerRes.json()) as { lastSeen: number }).lastSeen

  const { ws, events, open } = connectWs()
  await open
  const client = await connectMcp()
  const call = client.callTool({
    name: "ask",
    arguments: { question: "Blocked?", agent: "touch-agent", project: "hmux" }
  })
  const created = await waitFor(() =>
    events.find(
      (e): e is Extract<ServerEvent, { type: "message.new" }> =>
        e.type === "message.new" && e.message.body === "Blocked?"
    )
  )

  // Several 100ms keep-alive ticks pass; each bumps last_seen (no broadcast).
  await Bun.sleep(500)
  const during = await fetch(`${BASE}/sessions/touch-1`)
  expect((((await during.json()) as { lastSeen: number }).lastSeen)).toBeGreaterThan(before)

  ws.send(JSON.stringify({ type: "answer", id: created.message.id, text: "unblocked" }))
  await call
  await client.close()
  ws.close()
}, 15_000)

test("signal returns immediately, touches the session, publishes no message", async () => {
  const registerRes = await fetch(`${BASE}/sessions/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "sig-sess", agent: "sig-bot", project: "/sig/proj" })
  })
  const before = ((await registerRes.json()) as { lastSeen: number }).lastSeen
  await Bun.sleep(5)

  const { ws, events, open } = connectWs()
  await open
  const client = await connectMcp()
  const result = (await client.callTool({
    name: "signal",
    arguments: { status: "question", sessionId: "sig-sess" }
  })) as { content: Array<{ type: string; text: string }> }
  expect(result.content[0]?.text).toContain("question")

  // A signal is a label, not a message: nothing lands in the inbox.
  await Bun.sleep(300)
  expect(events.some((e) => e.type === "message.new" && e.message.agent === "sig-bot")).toBe(false)
  // But identity resolution doubles as a liveness touch.
  const touched = (await (await fetch(`${BASE}/sessions/sig-sess`)).json()) as {
    lastSeen: number
  }
  expect(touched.lastSeen).toBeGreaterThan(before)

  await client.close()
  ws.close()
}, 15_000)

test("notify returns immediately and shows up as pending", async () => {
  const { ws, events, open } = connectWs()
  await open

  const client = await connectMcp()
  const result = (await client.callTool({
    name: "notify",
    arguments: { message: "Build finished", agent: "e2e-agent" }
  })) as { content: Array<{ type: string; text: string }> }
  expect(result.content[0]?.text).toContain("Notification")

  const created = await waitFor(() =>
    events.find(
      (e): e is Extract<ServerEvent, { type: "message.new" }> =>
        e.type === "message.new" && e.message.body === "Build finished"
    )
  )
  expect(created.message.kind).toBe("notify")
  expect(created.message.status).toBe("pending")

  await client.close()
  ws.close()
}, 15_000)
