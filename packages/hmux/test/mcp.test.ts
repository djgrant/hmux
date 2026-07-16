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
const created: Array<[string, string | null, string | null]> = []
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
        panes: [
          { paneId: "%7", paneIndex: 1, dir: "~/Repos/api", agent: "api-3f2c · sonnet", active: true, transcript: transcriptPath, status: "message", detail: "approve the plan?" },
          { paneId: "%9", paneIndex: 2, dir: "~/Repos/api", agent: null, active: false, transcript: null, status: null, detail: null },
        ],
      },
      {
        target: "api:2", session: "api", name: "server", dir: "~/Repos/api",
        agent: null, active: false, paneCount: 1, paneId: "opaque-8",
        transcript: null, status: null, detail: null,
        panes: [
          { paneId: "opaque-8", paneIndex: 1, dir: "~/Repos/api", agent: null, active: false, transcript: null, status: null, detail: null },
        ],
      },
      {
        target: "api:3", session: "api", name: "pair", dir: "~/Repos/api",
        agent: "api-9a1b · sonnet", active: false, paneCount: 2, paneId: "%10",
        transcript: transcriptPath, status: "busy", detail: null,
        panes: [
          { paneId: "%10", paneIndex: 1, dir: "~/Repos/api", agent: "api-9a1b · sonnet", active: true, transcript: transcriptPath, status: "busy", detail: null },
          { paneId: "%11", paneIndex: 2, dir: "~/Repos/api", agent: "api-c4d8 · codex", active: false, transcript: transcriptPath, status: "idle", detail: null },
        ],
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
  create: async (n, opts) => (created.push([n, opts?.dir ?? null, opts?.command ?? null]), n),
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
    expect(result.target).toBe("api:1") // resolved to the canonical window target
    expect(result.turns).toHaveLength(2)
  })

  test("an unknown target and a missing transcript both explain themselves", async () => {
    const client = await connect()
    const miss = await call(client, "read", { target: "nope:9" })
    expect(miss).toContain("Nothing matches")
    expect(miss).toContain("api:1") // the miss names live targets
  })

  test("a pane id reads exactly that pane", async () => {
    const client = await connect()
    const result = JSON.parse(await call(client, "read", { target: "%7" }))
    expect(result.pane).toBe("%7")
    expect(result.target).toBe("api:1")
    // A plain sibling pane is its own address — and opaque, not its neighbour's transcript.
    expect(await call(client, "read", { target: "%9" })).toContain("advertised no transcript")
  })

  test("tmux pane addressing honors pane-base-index", async () => {
    const client = await connect()
    const result = JSON.parse(await call(client, "read", { target: "api:1.1" }))
    expect(result.pane).toBe("%7")
  })

  test("send addresses the window's agent pane", async () => {
    const client = await connect()
    await call(client, "send", { target: "api:1", message: "ship it" })
    expect(sent).toEqual([["%7", "ship it"]])
  })

  test("send accepts a backend-opaque pane handle", async () => {
    const client = await connect()
    sent.length = 0
    await call(client, "send", { target: "opaque-8", message: "wake up" })
    expect(sent).toEqual([["opaque-8", "wake up"]])
  })

  test("a window with two agents demands a pane, which sends verbatim", async () => {
    const client = await connect()
    sent.length = 0
    const refusal = await call(client, "send", { target: "api:3", message: "who gets this?" })
    expect(refusal).toContain("2 agents")
    expect(refusal).toContain("%10")
    expect(refusal).toContain("%11")
    expect(sent).toEqual([])
    await call(client, "send", { target: "%11", message: "you do" })
    expect(sent).toEqual([["%11", "you do"]])
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
    expect(created).toContainEqual(["ideas/webdav", null, null])
  })

  test("create threads dir and command through to the backend", async () => {
    const client = await connect()
    expect(
      await call(client, "create", { name: "api/fix-auth", dir: "~/Repos/api", command: "claude" }),
    ).toBe("api/fix-auth")
    expect(created).toContainEqual(["api/fix-auth", "~/Repos/api", "claude"])
  })

  test("list exposes each window's panes", async () => {
    const client = await connect()
    const result = JSON.parse(await call(client, "list"))
    const window = result[0].windows[0]
    expect(window.panes).toHaveLength(2)
    expect(window.panes[0]).toMatchObject({ paneId: "%7", paneIndex: 1, agent: "api-3f2c · sonnet", active: true, hasTranscript: true })
    expect(window.panes[1]).toMatchObject({ paneId: "%9", agent: null, active: false, hasTranscript: false })
  })
})
