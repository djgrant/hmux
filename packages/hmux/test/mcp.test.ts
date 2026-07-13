import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { buildServer } from "../src/mcp"
import type { Backend, DisplayTarget, SessionGroup } from "../src/backend"

const dir = mkdtempSync(join(tmpdir(), "hhmux-mcp-"))
const transcriptPath = join(dir, "abc.jsonl")

const sent: Array<[string, string]> = []
const openedInClient: Array<[string, string]> = []
const created: string[] = []
let liveTargets: DisplayTarget[] = []

const groups: SessionGroup[] = [
  {
    target: "api",
    name: "api",
    dir: "~/Repos/api",
    attached: true,
    status: "message",
    detail: "approve the plan?",
    windows: [
      {
        target: "api:1", session: "api", name: "claude", dir: "~/Repos/api",
        agent: "api-3f2c · sonnet", active: true, paneCount: 2, paneId: "%7",
        transcript: transcriptPath, status: "message", detail: "approve the plan?",
      },
      {
        target: "api:2", session: "api", name: "server", dir: "~/Repos/api",
        agent: null, active: false, paneCount: 1, paneId: "%8",
        transcript: null, status: null, detail: null,
      },
    ],
  },
]

const fakeBackend: Backend = {
  ensure: async () => {},
  list: async () => groups,
  open: async () => {},
  opensInPlace: () => false,
  targets: async () => liveTargets,
  openInClient: async (t, c) => void openedInClient.push([t, c.tty]),
  peekInClient: async () => {},
  create: async (n) => (created.push(n), n),
  send: async (paneId, message) => void sent.push([paneId, message]),
  rename: async () => {},
  kill: async () => {},
  saveSelection: async () => {},
  loadSelection: async () => null,
}

async function connect() {
  const client = new Client({ name: "test", version: "0.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await buildServer(fakeBackend).connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args })
  return (result.content as Array<{ type: string; text: string }>)[0].text
}

beforeAll(async () => {
  await Bun.write(
    transcriptPath,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      }),
    ].join("\n"),
  )
})

describe("hmux mcp tools", () => {
  test("list maps groups with hasTranscript", async () => {
    const client = await connect()
    const listed = JSON.parse(await call(client, "list"))
    expect(listed[0].windows[0].hasTranscript).toBe(true)
    expect(listed[0].windows[1].hasTranscript).toBe(false)
    expect(listed[0].windows[0].agent).toBe("api-3f2c · sonnet")
  })

  test("read returns turns for an advertised transcript", async () => {
    const client = await connect()
    const result = JSON.parse(await call(client, "read", { target: "api:1" }))
    expect(result.turns.map((t: { text: string }) => t.text)).toEqual(["hello", "hi there"])
  })

  test("a bare session name reads its first window", async () => {
    const client = await connect()
    const result = JSON.parse(await call(client, "read", { target: "api" }))
    expect(result.target).toBe("api")
    expect(result.turns).toHaveLength(2)
  })

  test("an unknown target and a missing transcript both explain themselves", async () => {
    const client = await connect()
    expect(await call(client, "read", { target: "nope:9" })).toContain("No window matches")
  })

  test("send addresses the window's agent pane", async () => {
    const client = await connect()
    await call(client, "send", { target: "api:1", message: "ship it" })
    expect(sent).toEqual([["%7", "ship it"]])
  })

  test("open reports when no display target is parked, routes when one is", async () => {
    const client = await connect()
    liveTargets = []
    expect(await call(client, "open", { target: "api" })).toContain("No display target")
    liveTargets = [{ tty: "/dev/ttys009", program: "ghostty" }]
    await call(client, "open", { target: "api" })
    expect(openedInClient).toEqual([["api", "/dev/ttys009"]])
  })

  test("create returns the new target", async () => {
    const client = await connect()
    expect(await call(client, "create", { name: "ideas/webdav" })).toBe("ideas/webdav")
    expect(created).toEqual(["ideas/webdav"])
  })
})
