// Tiny stub server for smoke-testing the TUI: bun run test/stub-server.ts
import type { ServerWebSocket } from "bun"
import { DEFAULT_PORT, WS_PATH, type Message, type ServerEvent, type Session } from "@humans/protocol"

const now = Date.now()
const messages: Message[] = [
  { id: "m1", kind: "ask", agent: "refactor-bot", project: "humans.sh", body: "Rename `Queue` to `Inbox`? It collides with the data structure.", status: "pending", createdAt: now - 2 * 60_000 },
  { id: "m2", kind: "ask", agent: "deploy-bot", project: "humans.sh", body: "Ship v0.0.1 to npm now, or wait for the docs PR?", context: "CI is green on main.", suggestion: "ship it now", status: "pending", createdAt: now - 60 * 60_000 },
  { id: "m3", kind: "ask", agent: "scraper", body: "Rate limit hit on API — back off for 1h?", status: "pending", createdAt: now - 5 * 60_000 },
  { id: "m4", kind: "ask", agent: "docs-bot", project: "humans.sh", body: "Use **bold** headings and `inline code` in the README?\n\n- option a\n- option b", status: "answered", answer: "Yes — go with **option a**.", createdAt: now - 3 * 60 * 60_000, answeredAt: now - 2 * 60 * 60_000 },
  { id: "m5", kind: "notify", agent: "ci-bot", project: "humans.sh", body: "Build passed on `main` (2m14s).", status: "pending", createdAt: now - 30_000 },
  // Approvals: permission prompts from headless agents (their own section).
  { id: "m6", kind: "approval", agent: "headless-1", project: "humans.sh", body: "wants to run Bash\n\n```json\n{\n  \"command\": \"rm -rf dist\"\n}\n```", suggestion: "allow", status: "pending", createdAt: now - 20_000 },
  { id: "m7", kind: "approval", agent: "headless-1", project: "humans.sh", body: "wants to run Edit\n\n```json\n{\n  \"file_path\": \"release.ts\"\n}\n```", suggestion: "allow", status: "pending", createdAt: now - 10_000 },
]

// Sessions covering every presence state: working (green dot on m1), idle +
// bound (dot on m2), needs-attention (accent dot on m5), and an ended session
// whose pending ask (m3) renders as a zombie.
const sessions: Session[] = [
  { id: "s1", agent: "refactor-bot", project: "humans.sh", model: "fable", status: "working", bound: false, startedAt: now - 10 * 60_000, lastSeen: now },
  { id: "s2", agent: "deploy-bot", project: "humans.sh", status: "idle", bound: true, startedAt: now - 90 * 60_000, lastSeen: now - 20_000 },
  { id: "s3", agent: "ci-bot", project: "humans.sh", status: "needs-attention", detail: "Claude needs your permission to use Bash", bound: false, startedAt: now - 40 * 60_000, lastSeen: now },
  { id: "s4", agent: "scraper", status: "idle", bound: false, startedAt: now - 3 * 60 * 60_000, lastSeen: now - 30 * 60_000, endedAt: now - 25 * 60_000 },
  // Stale but NOT ended (no heartbeat for 10m): stays listed, hollow marker.
  { id: "s5", agent: "prover", project: "humans.sh", status: "working", bound: false, startedAt: now - 5 * 60_000, lastSeen: now - 10 * 60_000 },
]

const sockets = new Set<ServerWebSocket<unknown>>()

function broadcast(event: ServerEvent) {
  const frame = JSON.stringify(event)
  for (const ws of sockets) ws.send(frame)
}

function upsertSession(session: Session) {
  const idx = sessions.findIndex((s) => s.id === session.id)
  if (idx === -1) sessions.push(session)
  else sessions[idx] = session
  broadcast({ type: "session.updated", session })
}

const port = Number(process.env.HUMANS_PORT) || DEFAULT_PORT
Bun.serve({
  port,
  async fetch(req, server) {
    const { pathname } = new URL(req.url)
    if (pathname === WS_PATH && server.upgrade(req)) return
    // Manual/PTY testing affordance: POST a Session JSON to register/update
    // an agent; it is upserted and broadcast as session.updated.
    if (pathname === "/session" && req.method === "POST") {
      upsertSession((await req.json()) as Session)
      return new Response("ok", { status: 200 })
    }
    // Manual/PTY testing affordance: POST a Message JSON to broadcast it as
    // message.new (exercises the full incoming-message side-effect path).
    if (pathname === "/message" && req.method === "POST") {
      const message = (await req.json()) as Message
      messages.push(message)
      broadcast({ type: "message.new", message })
      return new Response("ok", { status: 200 })
    }
    return new Response("stub", { status: 200 })
  },
  websocket: {
    open(ws) {
      sockets.add(ws)
      const init: ServerEvent = { type: "init", messages, sessions }
      ws.send(JSON.stringify(init))
    },
    close(ws) {
      sockets.delete(ws)
    },
    message(ws, raw) {
      const ev = JSON.parse(String(raw))
      if (ev.type === "answer") {
        const answered: ServerEvent = { type: "message.answered", id: ev.id, answer: ev.text, answeredAt: Date.now() }
        ws.send(JSON.stringify(answered))
      } else if (ev.type === "bind") {
        const session = sessions.find((s) => s.id === ev.sessionId)
        if (!session) return
        session.bound = ev.bound
        session.lastSeen = Date.now()
        broadcast({ type: "session.updated", session })
        console.log(`bind: ${session.agent} (${session.id}) bound=${session.bound}`)
      }
    },
  },
})
console.log(`stub server on ws://localhost:${port}${WS_PATH}`)
