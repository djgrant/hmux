export type MessageKind = "ask" | "notify" | "approval"
export type MessageStatus = "pending" | "answered"

export interface Message {
  id: string
  kind: MessageKind
  agent: string // self-declared agent name or generated id
  project?: string // e.g. cwd the agent passed
  body: string
  context?: string
  suggestion?: string // short suggested answer the human can accept with one key
  status: MessageStatus
  answer?: string
  createdAt: number // epoch ms
  answeredAt?: number
}

export type SessionStatus = "working" | "idle" | "needs-attention"

export interface Session {
  id: string // Claude Code session_id
  agent: string // display name, derived from project dir if not provided
  project?: string // e.g. the session's cwd
  model?: string
  status: SessionStatus
  detail?: string // short status reason, e.g. the permission-prompt text while blocked
  bound: boolean // human has bound this session to their inbox
  startedAt: number // epoch ms
  lastSeen: number // epoch ms; staleness is computed by consumers
  endedAt?: number
}

// WebSocket protocol (TUI <-> server), JSON frames:
export type ServerEvent =
  | { type: "init"; messages: Message[]; sessions: Session[] }
  | { type: "message.new"; message: Message }
  | { type: "message.answered"; id: string; answer: string; answeredAt: number }
  | { type: "session.updated"; session: Session }

export type ClientEvent =
  | { type: "answer"; id: string; text: string }
  | { type: "bind"; sessionId: string; bound: boolean }

export const DEFAULT_PORT = 7373
export const WS_PATH = "/ws"
export const MCP_PATH = "/mcp"

// --- Type guards -----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function isMessageKind(value: unknown): value is MessageKind {
  return value === "ask" || value === "notify" || value === "approval"
}

export function isMessageStatus(value: unknown): value is MessageStatus {
  return value === "pending" || value === "answered"
}

export function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false
  return (
    typeof value.id === "string" &&
    isMessageKind(value.kind) &&
    typeof value.agent === "string" &&
    (value.project === undefined || typeof value.project === "string") &&
    typeof value.body === "string" &&
    (value.context === undefined || typeof value.context === "string") &&
    (value.suggestion === undefined || typeof value.suggestion === "string") &&
    isMessageStatus(value.status) &&
    (value.answer === undefined || typeof value.answer === "string") &&
    typeof value.createdAt === "number" &&
    (value.answeredAt === undefined || typeof value.answeredAt === "number")
  )
}

export function isSessionStatus(value: unknown): value is SessionStatus {
  return value === "working" || value === "idle" || value === "needs-attention"
}

export function isSession(value: unknown): value is Session {
  if (!isRecord(value)) return false
  return (
    typeof value.id === "string" &&
    typeof value.agent === "string" &&
    (value.project === undefined || typeof value.project === "string") &&
    (value.model === undefined || typeof value.model === "string") &&
    isSessionStatus(value.status) &&
    (value.detail === undefined || typeof value.detail === "string") &&
    typeof value.bound === "boolean" &&
    typeof value.startedAt === "number" &&
    typeof value.lastSeen === "number" &&
    (value.endedAt === undefined || typeof value.endedAt === "number")
  )
}

export function isServerEvent(value: unknown): value is ServerEvent {
  if (!isRecord(value)) return false
  switch (value.type) {
    case "init":
      return (
        Array.isArray(value.messages) &&
        value.messages.every(isMessage) &&
        Array.isArray(value.sessions) &&
        value.sessions.every(isSession)
      )
    case "message.new":
      return isMessage(value.message)
    case "session.updated":
      return isSession(value.session)
    case "message.answered":
      return (
        typeof value.id === "string" &&
        typeof value.answer === "string" &&
        typeof value.answeredAt === "number"
      )
    default:
      return false
  }
}

export function isClientEvent(value: unknown): value is ClientEvent {
  if (!isRecord(value)) return false
  switch (value.type) {
    case "answer":
      return typeof value.id === "string" && typeof value.text === "string"
    case "bind":
      return typeof value.sessionId === "string" && typeof value.bound === "boolean"
    default:
      return false
  }
}
