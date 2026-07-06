import { createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { Message } from "@humans/protocol"

export type Mode = "next" | "queue"
export type ConnState = "connecting" | "open" | "reconnecting"

export const NO_PROJECT = "(no project)"

const [state, setState] = createStore({
  messages: [] as Message[],
  currentId: null as string | null,
  highlightId: null as string | null,
  mode: "next" as Mode,
  conn: "connecting" as ConnState,
})

export { state }

// Per-message composer drafts, preserved across message switches.
export const drafts = new Map<string, string>()

// Clock signal for live-ish age rendering.
const [now, setNow] = createSignal(Date.now())
setInterval(() => setNow(Date.now()), 15_000)
export { now }

export function formatAge(createdAt: number): string {
  const s = Math.max(0, Math.floor((now() - createdAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// --- Derived ---------------------------------------------------------------

/** All messages oldest-first. */
export const ordered = createMemo(() =>
  [...state.messages].sort((a, b) => a.createdAt - b.createdAt),
)

export interface Group {
  project: string
  messages: Message[]
}

/** Messages grouped by project (group order = first appearance, oldest-first). */
export const groups = createMemo<Group[]>(() => {
  const byProject = new Map<string, Message[]>()
  for (const m of ordered()) {
    const key = m.project ?? NO_PROJECT
    const list = byProject.get(key)
    if (list) list.push(m)
    else byProject.set(key, [m])
  }
  return [...byProject.entries()].map(([project, messages]) => ({ project, messages }))
})

/** Queue navigation order: groups flattened. */
export const flat = createMemo(() => groups().flatMap((g) => g.messages))

/** Pending messages in queue order. */
export const pending = createMemo(() => flat().filter((m) => m.status === "pending"))

export const currentMessage = createMemo(
  () => state.messages.find((m) => m.id === state.currentId) ?? null,
)

export const highlightMessage = createMemo(
  () => state.messages.find((m) => m.id === state.highlightId) ?? null,
)

/** The message whose body/composer is displayed right now. */
export const activeMessage = createMemo(() =>
  state.mode === "queue" ? highlightMessage() : currentMessage(),
)

/** "N/M" position of the current message among pending ones. */
export const position = createMemo(() => {
  const list = pending()
  const idx = list.findIndex((m) => m.id === state.currentId)
  return { n: idx + 1, m: list.length }
})

// --- Actions -----------------------------------------------------------------

function firstPendingId(): string | null {
  return pending()[0]?.id ?? null
}

export function setConn(conn: ConnState) {
  setState("conn", conn)
}

export function applyInit(messages: Message[]) {
  setState("messages", messages)
  if (!state.currentId || !state.messages.some((m) => m.id === state.currentId && m.status === "pending")) {
    setState("currentId", firstPendingId())
  }
}

export function addMessage(message: Message) {
  if (state.messages.some((m) => m.id === message.id)) return
  setState("messages", state.messages.length, message)
  if (!currentMessage() || currentMessage()!.status !== "pending") {
    setState("currentId", firstPendingId())
  }
}

export function markAnswered(id: string, answer: string, answeredAt: number) {
  const idx = state.messages.findIndex((m) => m.id === id)
  if (idx === -1) return
  setState("messages", idx, { status: "answered", answer, answeredAt })
  if (state.currentId === id) advance()
}

/** Move current pointer to the next pending message (wrapping). */
export function advance() {
  const list = flat()
  if (list.length === 0) {
    setState("currentId", null)
    return
  }
  const start = Math.max(0, list.findIndex((m) => m.id === state.currentId))
  for (let i = 1; i <= list.length; i++) {
    const m = list[(start + i) % list.length]!
    if (m.status === "pending") {
      setState("currentId", m.id)
      return
    }
  }
  setState("currentId", null)
}

export function openQueue(dir: 1 | -1) {
  const list = flat()
  if (list.length === 0) return
  const anchor = state.mode === "queue" ? state.highlightId : state.currentId
  const idx = list.findIndex((m) => m.id === anchor)
  const next = list[(idx + dir + list.length) % list.length]!
  setState({ mode: "queue", highlightId: next.id })
}

export function moveHighlight(dir: 1 | -1) {
  openQueue(dir)
}

/** Close the queue. If commit, the highlighted message becomes current. */
export function closeQueue(commit: boolean) {
  if (commit && state.highlightId) setState("currentId", state.highlightId)
  setState("mode", "next")
}
