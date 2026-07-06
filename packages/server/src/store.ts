import { Database } from "bun:sqlite"
import { Context, Effect, Layer } from "effect"
import type { Message, Session, SessionStatus } from "@humans/protocol"

interface MessageRow {
  id: string
  kind: string
  agent: string
  project: string | null
  body: string
  context: string | null
  suggestion: string | null
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
  ...(row.suggestion !== null && row.suggestion !== undefined
    ? { suggestion: row.suggestion }
    : {}),
  status: row.status as Message["status"],
  ...(row.answer !== null ? { answer: row.answer } : {}),
  createdAt: row.created_at,
  ...(row.answered_at !== null ? { answeredAt: row.answered_at } : {})
})

interface SessionRow {
  id: string
  agent: string
  project: string | null
  model: string | null
  status: string
  bound: number
  started_at: number
  last_seen: number
  ended_at: number | null
}

const rowToSession = (row: SessionRow): Session => ({
  id: row.id,
  agent: row.agent,
  ...(row.project !== null ? { project: row.project } : {}),
  ...(row.model !== null ? { model: row.model } : {}),
  status: row.status as Session["status"],
  bound: row.bound === 1,
  startedAt: row.started_at,
  lastSeen: row.last_seen,
  ...(row.ended_at !== null ? { endedAt: row.ended_at } : {})
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
    /**
     * Upserts a session. On conflict updates agent/project/model, bumps
     * last_seen and clears ended_at (a resumed session is live again), but
     * preserves status/bound/started_at.
     */
    readonly registerSession: (session: Session) => Effect.Effect<Session>
    readonly getSession: (id: string) => Effect.Effect<Session | undefined>
    readonly listSessions: Effect.Effect<Session[]>
    /** Updates status and bumps last_seen. Returns undefined for unknown sessions. */
    readonly setSessionStatus: (
      id: string,
      status: SessionStatus
    ) => Effect.Effect<Session | undefined>
    readonly setSessionBound: (
      id: string,
      bound: boolean
    ) => Effect.Effect<Session | undefined>
    /** Sets ended_at and bumps last_seen. Returns undefined for unknown sessions. */
    readonly endSession: (id: string) => Effect.Effect<Session | undefined>
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
      suggestion TEXT,
      status TEXT NOT NULL,
      answer TEXT,
      created_at INTEGER NOT NULL,
      answered_at INTEGER
    )
  `)
  // Migration for pre-existing databases created before the suggestion column
  // (the CREATE above is IF NOT EXISTS, so it won't add the column itself).
  try {
    db.run("ALTER TABLE messages ADD COLUMN suggestion TEXT")
  } catch {
    // Column already exists.
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      project TEXT,
      model TEXT,
      status TEXT NOT NULL,
      bound INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      ended_at INTEGER
    )
  `)

  const insert = db.prepare(`
    INSERT INTO messages (id, kind, agent, project, body, context, suggestion, status, answer, created_at, answered_at)
    VALUES ($id, $kind, $agent, $project, $body, $context, $suggestion, $status, $answer, $createdAt, $answeredAt)
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

  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, agent, project, model, status, bound, started_at, last_seen, ended_at)
    VALUES ($id, $agent, $project, $model, $status, $bound, $startedAt, $lastSeen, $endedAt)
    ON CONFLICT (id) DO UPDATE SET
      agent = excluded.agent,
      project = COALESCE(excluded.project, project),
      model = COALESCE(excluded.model, model),
      last_seen = excluded.last_seen,
      ended_at = NULL
  `)
  const selectSession = db.prepare("SELECT * FROM sessions WHERE id = $id")
  const selectSessions = db.prepare("SELECT * FROM sessions ORDER BY started_at ASC")
  const updateStatus = db.prepare(
    "UPDATE sessions SET status = $status, last_seen = $lastSeen WHERE id = $id"
  )
  const updateBound = db.prepare("UPDATE sessions SET bound = $bound WHERE id = $id")
  const markEnded = db.prepare(
    "UPDATE sessions SET ended_at = $endedAt, last_seen = $lastSeen WHERE id = $id"
  )

  const getSession = (id: string) => {
    const row = selectSession.get({ $id: id }) as SessionRow | null
    return row ? rowToSession(row) : undefined
  }

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
          $suggestion: message.suggestion ?? null,
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
      }),

    registerSession: (session) =>
      Effect.sync(() => {
        upsertSession.run({
          $id: session.id,
          $agent: session.agent,
          $project: session.project ?? null,
          $model: session.model ?? null,
          $status: session.status,
          $bound: session.bound ? 1 : 0,
          $startedAt: session.startedAt,
          $lastSeen: session.lastSeen,
          $endedAt: session.endedAt ?? null
        })
        // Re-read: on conflict the stored status/bound/started_at win.
        return getSession(session.id) ?? session
      }),

    getSession: (id) => Effect.sync(() => getSession(id)),

    listSessions: Effect.sync(() =>
      (selectSessions.all() as SessionRow[]).map(rowToSession)
    ),

    setSessionStatus: (id, status) =>
      Effect.sync(() => {
        updateStatus.run({ $id: id, $status: status, $lastSeen: Date.now() })
        return getSession(id)
      }),

    setSessionBound: (id, bound) =>
      Effect.sync(() => {
        updateBound.run({ $id: id, $bound: bound ? 1 : 0 })
        return getSession(id)
      }),

    endSession: (id) =>
      Effect.sync(() => {
        markEnded.run({ $id: id, $endedAt: Date.now(), $lastSeen: Date.now() })
        return getSession(id)
      })
  })
})
