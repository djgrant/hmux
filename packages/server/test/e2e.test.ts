import { afterAll, beforeAll, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  isServerEvent,
  type Message,
  type ServerEvent
} from "@humans/protocol"

const PORT = 7911
const BASE = `http://localhost:${PORT}`
const DB = `${import.meta.dir}/.e2e-${Date.now()}.db`

let proc: Bun.Subprocess

beforeAll(async () => {
  proc = Bun.spawn(["bun", "run", `${import.meta.dir}/../src/index.ts`], {
    env: { ...process.env, HUMANS_PORT: String(PORT), HUMANS_DB: DB },
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

const connectMcp = async () => {
  const client = new Client({ name: "e2e", version: "0.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)))
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
      project: "humans.sh"
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
