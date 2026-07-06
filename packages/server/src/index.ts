import { Effect, Layer, ManagedRuntime } from "effect"
import {
  DEFAULT_PORT,
  MCP_PATH,
  WS_PATH,
  isClientEvent,
  isSessionStatus,
  type ServerEvent
} from "@humans/protocol"
import { Hub, HubLive } from "./hub"
import { Store, StoreLive } from "./store"
import { makeMcpHandler } from "./mcp"

const MainLayer = Layer.provideMerge(HubLive, StoreLive)
const runtime = ManagedRuntime.make(MainLayer)
const run = <A, E>(effect: Effect.Effect<A, E, Hub | Store>) => runtime.runPromise(effect)

const mcpHandler = makeMcpHandler(run)

const WS_TOPIC = "events"
const port = Number(process.env.HUMANS_PORT ?? DEFAULT_PORT)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

/**
 * Plain-JSON session endpoints for the Claude Code plugin hooks (local v1,
 * no auth):
 *
 *   POST /sessions/register    {id, agent?, project?, model?}
 *   POST /sessions/:id/status  {status}
 *   POST /sessions/:id/end
 *   GET  /sessions/:id
 *
 * Returns undefined for paths outside /sessions.
 */
const handleSessions = async (req: Request, url: URL): Promise<Response | undefined> => {
  const match = url.pathname.match(/^\/sessions(?:\/(.*))?$/)
  if (!match) return undefined
  const rest = match[1] ?? ""

  if (req.method === "POST" && rest === "register") {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return json({ error: "invalid JSON body" }, 400)
    }
    const b = body as Record<string, unknown>
    if (typeof b?.id !== "string" || b.id.length === 0) {
      return json({ error: "id is required" }, 400)
    }
    const session = await run(
      Effect.flatMap(Hub, (hub) =>
        hub.registerSession({
          id: b.id as string,
          ...(typeof b.agent === "string" ? { agent: b.agent } : {}),
          ...(typeof b.project === "string" ? { project: b.project } : {}),
          ...(typeof b.model === "string" ? { model: b.model } : {})
        })
      )
    )
    return json(session)
  }

  const statusMatch = rest.match(/^([^/]+)\/status$/)
  if (req.method === "POST" && statusMatch) {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return json({ error: "invalid JSON body" }, 400)
    }
    const status = (body as Record<string, unknown>)?.status
    if (!isSessionStatus(status)) {
      return json({ error: "status must be working | idle | needs-attention" }, 400)
    }
    const session = await run(
      Effect.flatMap(Hub, (hub) => hub.updateSessionStatus(statusMatch[1]!, status))
    )
    return json(session)
  }

  const endMatch = rest.match(/^([^/]+)\/end$/)
  if (req.method === "POST" && endMatch) {
    const session = await run(Effect.flatMap(Hub, (hub) => hub.endSession(endMatch[1]!)))
    return json(session)
  }

  if (req.method === "GET" && /^[^/]+$/.test(rest)) {
    const session = await run(Effect.flatMap(Store, (store) => store.getSession(rest)))
    return session ? json(session) : json({ error: "not found" }, 404)
  }

  return json({ error: "not found" }, 404)
}

const server = Bun.serve<undefined>({
  port,
  idleTimeout: 0,
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === WS_PATH) {
      return srv.upgrade(req)
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 400 })
    }
    if (url.pathname === MCP_PATH) {
      return mcpHandler(req)
    }
    const sessions = await handleSessions(req, url)
    if (sessions) return sessions
    return new Response("Not found", { status: 404 })
  },
  websocket: {
    async open(ws) {
      ws.subscribe(WS_TOPIC)
      const [messages, sessions] = await run(
        Effect.flatMap(Store, (store) =>
          Effect.all([store.list, store.listSessions])
        )
      )
      ws.send(JSON.stringify({ type: "init", messages, sessions } satisfies ServerEvent))
    },
    async message(ws, raw) {
      let event: unknown
      try {
        event = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
      } catch {
        return
      }
      if (!isClientEvent(event)) return
      if (event.type === "answer") {
        await run(Effect.flatMap(Hub, (hub) => hub.answer(event.id, event.text)))
      } else if (event.type === "bind") {
        await run(
          Effect.flatMap(Hub, (hub) => hub.bindSession(event.sessionId, event.bound))
        )
      }
    },
    close(ws) {
      ws.unsubscribe(WS_TOPIC)
    }
  }
})

await run(
  Effect.flatMap(Hub, (hub) =>
    hub.setBroadcast((event) => {
      server.publish(WS_TOPIC, JSON.stringify(event))
    })
  )
)

console.log(`humans.sh server listening on http://localhost:${server.port}`)
console.log(`  TUI websocket:  ws://localhost:${server.port}${WS_PATH}`)
console.log(`  MCP endpoint:   http://localhost:${server.port}${MCP_PATH}`)
console.log(
  `  Register with:  claude mcp add --transport http humans http://localhost:${server.port}${MCP_PATH}`
)
