export type MessageKind = "ask" | "notify"
export type MessageStatus = "pending" | "answered"

export interface Message {
  id: string
  kind: MessageKind
  agent: string // self-declared agent name or generated id
  project?: string // e.g. cwd the agent passed
  body: string
  context?: string
  status: MessageStatus
  answer?: string
  createdAt: number // epoch ms
  answeredAt?: number
}

// WebSocket protocol (TUI <-> server), JSON frames:
export type ServerEvent =
  | { type: "init"; messages: Message[] }
  | { type: "message.new"; message: Message }
  | { type: "message.answered"; id: string; answer: string; answeredAt: number }

export type ClientEvent = { type: "answer"; id: string; text: string }

export const DEFAULT_PORT = 7373
export const WS_PATH = "/ws"
export const MCP_PATH = "/mcp"

// --- Type guards -----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function isMessageKind(value: unknown): value is MessageKind {
  return value === "ask" || value === "notify"
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
    isMessageStatus(value.status) &&
    (value.answer === undefined || typeof value.answer === "string") &&
    typeof value.createdAt === "number" &&
    (value.answeredAt === undefined || typeof value.answeredAt === "number")
  )
}

export function isServerEvent(value: unknown): value is ServerEvent {
  if (!isRecord(value)) return false
  switch (value.type) {
    case "init":
      return Array.isArray(value.messages) && value.messages.every(isMessage)
    case "message.new":
      return isMessage(value.message)
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
  return (
    value.type === "answer" &&
    typeof value.id === "string" &&
    typeof value.text === "string"
  )
}
