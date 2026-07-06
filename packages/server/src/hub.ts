import { Context, Deferred, Effect, Layer } from "effect"
import type { Message, ServerEvent } from "@humans/protocol"
import { Store } from "./store"

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
