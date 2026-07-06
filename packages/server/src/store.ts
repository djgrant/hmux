import { Database } from "bun:sqlite"
import { Context, Effect, Layer } from "effect"
import type { Message } from "@humans/protocol"

interface MessageRow {
  id: string
  kind: string
  agent: string
  project: string | null
  body: string
  context: string | null
  status: string
  answer: string | null
  created_at: number
  answered_at: number | null
}

const rowToMessage = (row: MessageRow): Message => ({
  id: row.id,
  kind: row.kind as Message["kind"],
  agent: row.agent,
  ...(row.project !== null ? { project: row.project } : {}),
  body: row.body,
  ...(row.context !== null ? { context: row.context } : {}),
  status: row.status as Message["status"],
  ...(row.answer !== null ? { answer: row.answer } : {}),
  createdAt: row.created_at,
  ...(row.answered_at !== null ? { answeredAt: row.answered_at } : {})
})

export class Store extends Context.Tag("@humans/server/Store")<
  Store,
  {
    readonly create: (message: Message) => Effect.Effect<Message>
    readonly get: (id: string) => Effect.Effect<Message | undefined>
    readonly list: Effect.Effect<Message[]>
    readonly listPending: Effect.Effect<Message[]>
    /**
     * Marks a message answered. Returns the updated message, or undefined if
     * the message does not exist. Idempotent: an already-answered message is
     * returned unchanged.
     */
    readonly answer: (id: string, text: string) => Effect.Effect<Message | undefined>
  }
>() {}

export const StoreLive = Layer.sync(Store, () => {
  const db = new Database(process.env.HUMANS_DB ?? "humans.db", { create: true })
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      agent TEXT NOT NULL,
      project TEXT,
      body TEXT NOT NULL,
      context TEXT,
      status TEXT NOT NULL,
      answer TEXT,
      created_at INTEGER NOT NULL,
      answered_at INTEGER
    )
  `)

  const insert = db.prepare(`
    INSERT INTO messages (id, kind, agent, project, body, context, status, answer, created_at, answered_at)
    VALUES ($id, $kind, $agent, $project, $body, $context, $status, $answer, $createdAt, $answeredAt)
  `)
  const selectOne = db.prepare("SELECT * FROM messages WHERE id = $id")
  const selectAll = db.prepare("SELECT * FROM messages ORDER BY created_at ASC")
  const selectPending = db.prepare(
    "SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC"
  )
  const markAnswered = db.prepare(`
    UPDATE messages SET status = 'answered', answer = $answer, answered_at = $answeredAt
    WHERE id = $id AND status = 'pending'
  `)

  return Store.of({
    create: (message) =>
      Effect.sync(() => {
        insert.run({
          $id: message.id,
          $kind: message.kind,
          $agent: message.agent,
          $project: message.project ?? null,
          $body: message.body,
          $context: message.context ?? null,
          $status: message.status,
          $answer: message.answer ?? null,
          $createdAt: message.createdAt,
          $answeredAt: message.answeredAt ?? null
        })
        return message
      }),

    get: (id) =>
      Effect.sync(() => {
        const row = selectOne.get({ $id: id }) as MessageRow | null
        return row ? rowToMessage(row) : undefined
      }),

    list: Effect.sync(() => (selectAll.all() as MessageRow[]).map(rowToMessage)),

    listPending: Effect.sync(() =>
      (selectPending.all() as MessageRow[]).map(rowToMessage)
    ),

    answer: (id, text) =>
      Effect.sync(() => {
        markAnswered.run({ $id: id, $answer: text, $answeredAt: Date.now() })
        const row = selectOne.get({ $id: id }) as MessageRow | null
        return row ? rowToMessage(row) : undefined
      })
  })
})
