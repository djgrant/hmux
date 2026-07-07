import { Context, Deferred, Effect, Layer } from "effect"
import type { Message, ServerEvent, Session, SessionStatus } from "@humans/protocol"
import { Store } from "./store"

export interface RegisterSessionInput {
  id: string
  agent?: string
  project?: string
  model?: string
}

/** Default agent name: last path segment of the project + short id suffix. */
const deriveAgent = (input: RegisterSessionInput): string => {
  const dir = input.project?.split("/").filter(Boolean).pop()
  return `${dir ?? "agent"}-${input.id.slice(0, 4)}`
}

/** Minimal session for quiet upsert-registration of unknown session ids. */
const quietSession = (id: string): Session => ({
  id,
  agent: deriveAgent({ id }),
  status: "working",
  bound: false,
  startedAt: Date.now(),
  lastSeen: Date.now()
})

/**
 * Hub coordinates the two things that happen around message state changes:
 *
 * 1. Waiters — in-flight MCP `ask` calls block on a Deferred keyed by message
 *    id until the human answers.
 * 2. Broadcast — every WS client gets `message.new` / `message.answered`
 *    ServerEvents. The actual fan-out is injected by the HTTP layer (Bun's
 *    server.publish) via setBroadcast.
 */
export class Hub extends Context.Tag("@humans/server/Hub")<
  Hub,
  {
    readonly setBroadcast: (fn: (event: ServerEvent) => void) => Effect.Effect<void>
    /** Persist a new message and broadcast message.new. */
    readonly publishNew: (message: Message) => Effect.Effect<Message>
    /** Block until the message with this id is answered; returns the answer text. */
    readonly awaitAnswer: (id: string) => Effect.Effect<string>
    /**
     * Persist an answer, resolve any waiter, broadcast message.answered.
     * No-ops (returns undefined) for unknown or already-answered messages.
     */
    readonly answer: (id: string, text: string) => Effect.Effect<Message | undefined>
    /** Upsert-register a session and broadcast session.updated. */
    readonly registerSession: (input: RegisterSessionInput) => Effect.Effect<Session>
    /**
     * Update a session's status (bumping last_seen) and broadcast
     * session.updated. Unknown sessions are quietly upsert-registered first —
     * hooks can fire in any order for resumed sessions. `detail` is the
     * status reason (stored with needs-attention only; see Store).
     */
    readonly updateSessionStatus: (
      id: string,
      status: SessionStatus,
      detail?: string
    ) => Effect.Effect<Session>
    /**
     * Bump last_seen for the live session matching an agent name (exact
     * agent+project preferred). Deliberately does NOT broadcast: this fires
     * on every keep-alive tick of a blocked ask/approve, and spamming
     * session.updated every ~20s buys nothing — the TUI computes staleness
     * from its own clock, so the fresher last_seen reaches clients with the
     * next real session event (or the init frame on reconnect).
     */
    readonly touchSessionByAgent: (agent: string, project?: string) => Effect.Effect<void>
    /** Mark a session ended and broadcast session.updated. Upserts if unknown. */
    readonly endSession: (id: string) => Effect.Effect<Session>
    /**
     * Set a session's bound flag and broadcast session.updated. No-ops
     * (returns undefined) for unknown sessions.
     */
    readonly bindSession: (
      id: string,
      bound: boolean
    ) => Effect.Effect<Session | undefined>
  }
>() {}

export const HubLive = Layer.effect(
  Hub,
  Effect.gen(function* () {
    const store = yield* Store
    const waiters = new Map<string, Deferred.Deferred<string>>()
    let broadcast: (event: ServerEvent) => void = () => {}

    const waiterFor = (id: string) =>
      Effect.suspend(() => {
        const existing = waiters.get(id)
        if (existing) return Effect.succeed(existing)
        return Deferred.make<string>().pipe(
          Effect.tap((d) => Effect.sync(() => waiters.set(id, d)))
        )
      })

    return Hub.of({
      setBroadcast: (fn) =>
        Effect.sync(() => {
          broadcast = fn
        }),

      publishNew: (message) =>
        store.create(message).pipe(
          Effect.tap(() => Effect.sync(() => broadcast({ type: "message.new", message })))
        ),

      awaitAnswer: (id) =>
        Effect.gen(function* () {
          // Attach the waiter before checking the store: answer() only
          // resolves waiters already in the map, so checking first leaves a
          // gap where an answer could land and the waiter would hang forever.
          const deferred = yield* waiterFor(id)
          const existing = yield* store.get(id)
          if (existing?.status === "answered" && existing.answer !== undefined) {
            waiters.delete(id)
            return existing.answer
          }
          return yield* Deferred.await(deferred)
        }),

      registerSession: (input) =>
        Effect.gen(function* () {
          const now = Date.now()
          const session = yield* store.registerSession({
            id: input.id,
            agent: input.agent ?? deriveAgent(input),
            ...(input.project !== undefined ? { project: input.project } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            status: "working",
            bound: false,
            startedAt: now,
            lastSeen: now
          })
          broadcast({ type: "session.updated", session })
          return session
        }),

      updateSessionStatus: (id, status, detail) =>
        Effect.gen(function* () {
          let session = yield* store.setSessionStatus(id, status, detail)
          if (!session) {
            yield* store.registerSession(quietSession(id))
            session = yield* store.setSessionStatus(id, status, detail)
          }
          if (!session) return yield* Effect.die(`session ${id} vanished`)
          // A blocked session surfaces as a roster label (status + detail),
          // never as a queue message — the human can't action a terminal
          // permission prompt from the inbox.
          broadcast({ type: "session.updated", session })
          return session
        }),

      touchSessionByAgent: (agent, project) => store.touchSessionByAgent(agent, project),

      endSession: (id) =>
        Effect.gen(function* () {
          let session = yield* store.endSession(id)
          if (!session) {
            yield* store.registerSession(quietSession(id))
            session = yield* store.endSession(id)
          }
          if (!session) return yield* Effect.die(`session ${id} vanished`)
          broadcast({ type: "session.updated", session })
          return session
        }),

      bindSession: (id, bound) =>
        Effect.gen(function* () {
          const session = yield* store.setSessionBound(id, bound)
          if (!session) return undefined
          broadcast({ type: "session.updated", session })
          return session
        }),

      answer: (id, text) =>
        Effect.gen(function* () {
          const before = yield* store.get(id)
          if (!before || before.status === "answered") return before
          const updated = yield* store.answer(id, text)
          if (!updated || updated.status !== "answered") return undefined
          const deferred = waiters.get(id)
          if (deferred) {
            waiters.delete(id)
            yield* Deferred.succeed(deferred, updated.answer ?? text)
          }
          broadcast({
            type: "message.answered",
            id,
            answer: updated.answer ?? text,
            answeredAt: updated.answeredAt ?? Date.now()
          })
          return updated
        })
    })
  })
)
