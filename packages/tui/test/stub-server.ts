// Tiny stub server for smoke-testing the TUI: bun run test/stub-server.ts
import { DEFAULT_PORT, WS_PATH, type Message, type ServerEvent } from "@humans/protocol"

const now = Date.now()
const messages: Message[] = [
  { id: "m1", kind: "ask", agent: "refactor-bot", project: "humans.sh", body: "Rename `Queue` to `Inbox`? It collides with the data structure.", status: "pending", createdAt: now - 2 * 60_000 },
  { id: "m2", kind: "ask", agent: "deploy-bot", project: "humans.sh", body: "Ship v0.0.1 to npm now, or wait for the docs PR?", context: "CI is green on main.", status: "pending", createdAt: now - 60 * 60_000 },
  { id: "m3", kind: "ask", agent: "scraper", body: "Rate limit hit on API — back off for 1h?", status: "pending", createdAt: now - 5 * 60_000 },
]

const port = Number(process.env.HUMANS_PORT) || DEFAULT_PORT
Bun.serve({
  port,
  fetch(req, server) {
    if (new URL(req.url).pathname === WS_PATH && server.upgrade(req)) return
    return new Response("stub", { status: 200 })
  },
  websocket: {
    open(ws) {
      const init: ServerEvent = { type: "init", messages }
      ws.send(JSON.stringify(init))
    },
    message(ws, raw) {
      const ev = JSON.parse(String(raw))
      if (ev.type === "answer") {
        const answered: ServerEvent = { type: "message.answered", id: ev.id, answer: ev.text, answeredAt: Date.now() }
        ws.send(JSON.stringify(answered))
      }
    },
  },
})
console.log(`stub server on ws://localhost:${port}${WS_PATH}`)
