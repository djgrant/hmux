import { Effect, Layer, ManagedRuntime } from "effect"
import {
  DEFAULT_PORT,
  MCP_PATH,
  WS_PATH,
  isClientEvent,
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
    return new Response("Not found", { status: 404 })
  },
  websocket: {
    async open(ws) {
      ws.subscribe(WS_TOPIC)
      const messages = await run(Effect.flatMap(Store, (store) => store.list))
      ws.send(JSON.stringify({ type: "init", messages } satisfies ServerEvent))
    },
    async message(ws, raw) {
      let event: unknown
      try {
        event = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
      } catch {
        return
      }
      if (!isClientEvent(event)) return
      const { id, text } = event
      await run(Effect.flatMap(Hub, (hub) => hub.answer(id, text)))
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
