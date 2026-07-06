import { createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { Message, Session } from "@humans/protocol"

export type Focus = "composer" | "queue"
export type ConnState = "connecting" | "open" | "reconnecting"

export const NO_PROJECT = "(no project)"

const [state, setState] = createStore({
  messages: [] as Message[],
  sessions: [] as Session[],
  currentId: null as string | null,
  highlightId: null as string | null,
  /** Selection anchor while shift-extending in the queue (null = no range). */
  selectAnchorId: null as string | null,
  /** Ids answered together in merged mode ([] = normal single-message mode). */
  merged: [] as string[],
  /** Which pane owns the keyboard. The queue sidebar is always visible. */
  focus: "composer" as Focus,
  conn: "connecting" as ConnState,
})

export { state }

// --- Drafts (persisted) ------------------------------------------------------

// Per-message composer drafts (text + cursor offset), preserved and restored
// across message switches and — via ~/.humans/drafts.json — across restarts.
export interface Draft {
  text: string
  cursor: number
}
export const drafts = new Map<string, Draft>()

let draftsPath: string | null = null
let persistTimer: ReturnType<typeof setTimeout> | undefined

function isDraft(value: unknown): value is Draft {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Draft).text === "string" &&
    typeof (value as Draft).cursor === "number"
  )
}

/**
 * Enable draft persistence and load any saved drafts. Called once on startup;
 * tests pass an explicit path. Without a call, drafts stay in-memory only.
 */
export function loadDrafts(
  path = process.env.HUMANS_DRAFTS_PATH ?? join(homedir(), ".humans", "drafts.json"),
) {
  draftsPath = path
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (typeof data === "object" && data !== null) {
      for (const [id, draft] of Object.entries(data)) {
        if (isDraft(draft)) drafts.set(id, draft)
      }
    }
  } catch {
    // No file yet (or unreadable): start empty.
  }
}

/** Debounced (~300ms) write-behind of the drafts Map. */
function persistDrafts() {
  if (!draftsPath) return
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      mkdirSync(dirname(draftsPath!), { recursive: true })
      // Merged-composer drafts (synthetic "a+b" keys) are session-scoped.
      const entries = [...drafts].filter(([id]) => !id.includes("+"))
      writeFileSync(draftsPath!, JSON.stringify(Object.fromEntries(entries)))
    } catch {
      // Persistence is best-effort.
    }
  }, 300)
}

export function setDraft(id: string, draft: Draft) {
  drafts.set(id, draft)
  persistDrafts()
}

export function deleteDraft(id: string) {
  if (drafts.delete(id)) persistDrafts()
}

// Whether the focused composer is currently empty (ghost suggestion showing).
// A signal (not the drafts Map) so the footer hint can react to it.
const [composerEmpty, setComposerEmpty] = createSignal(true)
export { composerEmpty, setComposerEmpty }

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

// --- Incoming-message banner -------------------------------------------------

const [banner, setBanner] = createSignal<string | null>(null)
export { banner }
let bannerTimer: ReturnType<typeof setTimeout> | undefined

function flashBanner(text: string, durationMs: number) {
  setBanner(text)
  clearTimeout(bannerTimer)
  bannerTimer = setTimeout(() => setBanner(null), durationMs)
}

/** Show a brief top-right banner for a new message; the latest message wins. */
export function showBanner(message: Message) {
  const firstLine = message.body.split("\n")[0] ?? ""
  flashBanner(`${message.agent}: ${firstLine}`.slice(0, 40), 4_000)
}

/** Brief top-right toast (e.g. "copied"); reuses the banner slot. */
export function showToast(text: string, durationMs = 1_500) {
  flashBanner(text, durationMs)
}

// Latest freshly-arrived message (message.new). Distinct from the banner text
// so the App can react with renderer-level side effects (OS notification);
// the ws handler in index.tsx runs outside render and has no renderer handle.
const [incoming, setIncoming] = createSignal<Message | null>(null)
export { incoming }

/** Announce a message.new: flash the banner and expose it to App effects. */
export function announceIncoming(message: Message) {
  showBanner(message)
  setIncoming(message)
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

/**
 * Pending messages grouped by project (group order = first appearance,
 * oldest-first). Answered messages are not listed in the queue at all.
 */
export const groups = createMemo<Group[]>(() => {
  const byProject = new Map<string, Group>()
  for (const m of ordered()) {
    if (m.status !== "pending") continue
    const key = m.project ?? NO_PROJECT
    let group = byProject.get(key)
    if (!group) {
      group = { project: key, messages: [] }
      byProject.set(key, group)
    }
    group.messages.push(m)
  }
  return [...byProject.values()]
})

/** Queue navigation order (pending only), matching the displayed order. */
export const pending = createMemo(() => groups().flatMap((g) => g.messages))

// --- Sessions / presence -----------------------------------------------------

/** Sessions with no heartbeat for this long are presumed dead. */
export const SESSION_STALE_MS = 90_000

/** Presumed dead: explicitly ended, or silent past the staleness threshold. */
export function sessionStale(session: Session, at = now()): boolean {
  return session.endedAt !== undefined || at - session.lastSeen > SESSION_STALE_MS
}

/** Live (non-ended, non-stale) sessions in arrival order — the roster. */
export const roster = createMemo(() =>
  state.sessions.filter((s) => !sessionStale(s)).sort((a, b) => a.startedAt - b.startedAt),
)

/**
 * The session backing a message: conservative match on agent AND project
 * (both-undefined counts as the same project). A name match alone is not
 * enough — two projects can run same-named agents.
 */
export function sessionFor(m: Message): Session | undefined {
  return state.sessions.find((s) => s.agent === m.agent && s.project === m.project)
}

export type Presence = "live" | "attention" | "dead" | "none"

/** Presence of the agent behind a message, for the queue-row marker. */
export function presenceOf(m: Message): Presence {
  const s = sessionFor(m)
  if (!s) return "none"
  if (sessionStale(s)) return "dead"
  return s.status === "needs-attention" ? "attention" : "live"
}

/**
 * Queue navigation order: pending messages first, then roster rows. One flat
 * list so cmd/shift+↑↓ continues past the last message group into the roster
 * without a new focus mode.
 */
interface NavItem {
  kind: "message" | "session"
  id: string
}
const navItems = createMemo<NavItem[]>(() => [
  ...pending().map((m): NavItem => ({ kind: "message", id: m.id })),
  ...roster().map((s): NavItem => ({ kind: "session", id: s.id })),
])

export const currentMessage = createMemo(
  () => state.messages.find((m) => m.id === state.currentId) ?? null,
)

export const highlightMessage = createMemo(
  () => state.messages.find((m) => m.id === state.highlightId) ?? null,
)

/** The roster session under the queue highlight (null when on a message). */
export const highlightedSession = createMemo(() =>
  state.focus === "queue" && !highlightMessage()
    ? (state.sessions.find((s) => s.id === state.highlightId) ?? null)
    : null,
)

/** The message whose body/composer is displayed in the main pane. */
export const activeMessage = createMemo(() =>
  state.focus === "queue" ? (highlightMessage() ?? currentMessage()) : currentMessage(),
)

/**
 * The contiguous shift-selected range in the queue (anchor..highlight, in
 * queue order). Empty unless a shift-selection is in progress.
 */
export const selectedIds = createMemo<string[]>(() => {
  if (state.focus !== "queue" || !state.selectAnchorId || !state.highlightId) return []
  const list = pending()
  const a = list.findIndex((m) => m.id === state.selectAnchorId)
  const b = list.findIndex((m) => m.id === state.highlightId)
  if (a < 0 || b < 0) return []
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return list.slice(lo, hi + 1).map((m) => m.id)
})

/** Messages being answered together in merged mode. */
export const mergedMessages = createMemo(() =>
  state.merged
    .map((id) => state.messages.find((m) => m.id === id))
    .filter((m): m is Message => m !== undefined && m.status === "pending"),
)

/** "N/M" position of the current message among pending ones. */
export const position = createMemo(() => {
  const list = pending()
  const idx = list.findIndex((m) => m.id === state.currentId)
  return { n: idx + 1, m: list.length }
})

/** Pending messages other than the current one ("N waiting"). */
export const unread = createMemo(
  () => pending().filter((m) => m.id !== state.currentId).length,
)

// --- Actions -----------------------------------------------------------------

function firstPendingId(): string | null {
  return pending()[0]?.id ?? null
}

export function setConn(conn: ConnState) {
  setState("conn", conn)
}

export function applyInit(messages: Message[], sessions: Session[] = []) {
  setState("messages", messages)
  setState("sessions", sessions)
  if (!state.currentId || !state.messages.some((m) => m.id === state.currentId && m.status === "pending")) {
    setState("currentId", firstPendingId())
  }
  // Prune persisted drafts for messages that arrive already answered.
  for (const m of messages) {
    if (m.status === "answered") deleteDraft(m.id)
  }
}

/** session.updated: upsert by id (whole-object replace, no field merge). */
export function upsertSession(session: Session) {
  setState("sessions", (list) => {
    const idx = list.findIndex((s) => s.id === session.id)
    return idx === -1 ? [...list, session] : list.map((s, i) => (i === idx ? session : s))
  })
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
  // The answered message vanishes from the queue; re-anchor the highlight.
  if (state.highlightId === id) setState("highlightId", state.currentId)
}

/** Move current pointer to the next pending message (wrapping). */
export function advance() {
  const list = pending()
  if (list.length === 0) {
    setState("currentId", null)
    return
  }
  const idx = list.findIndex((m) => m.id === state.currentId)
  setState("currentId", list[(idx + 1) % list.length]!.id)
}

/**
 * Give the queue focus and move the highlight by dir (0 = anchor on the
 * current message without moving). Entry from the composer never starts a
 * selection.
 */
export function focusQueue(dir: 1 | -1 | 0) {
  const list = navItems()
  if (list.length === 0) return
  const anchor = state.focus === "queue" ? state.highlightId : state.currentId
  const idx = Math.max(0, list.findIndex((it) => it.id === anchor))
  const next = list[(idx + dir + list.length) % list.length]!
  setState({ focus: "queue", highlightId: next.id, selectAnchorId: null })
}

/** Plain ↑/↓ while the queue has focus: move highlight, collapse selection. */
export function moveHighlight(dir: 1 | -1) {
  focusQueue(dir)
}

/**
 * shift+↑↓ from the composer: switch the current message in place (queue
 * order, wrapping) WITHOUT moving focus — the composer keeps the keyboard
 * and the new message's draft loads via the keyed remount. The sidebar
 * highlight follows so the selected row still reads; any merged mode or
 * stale selection anchor is dropped. shift+← remains the way into the queue.
 */
export function cycleCurrent(dir: 1 | -1) {
  const list = pending()
  if (list.length === 0) return
  const idx = list.findIndex((m) => m.id === state.currentId)
  const next = list[(idx + dir + list.length) % list.length]!
  setState({ currentId: next.id, highlightId: next.id, merged: [], selectAnchorId: null })
}

/**
 * shift+↑/↓ while the queue has focus: extend a contiguous selection anchored
 * at the highlight. Clamped (no wrap) so the range stays contiguous.
 */
export function extendSelection(dir: 1 | -1) {
  const list = pending()
  const idx = list.findIndex((m) => m.id === state.highlightId)
  // Roster rows can't join a message selection; shift+↑↓ just moves there.
  if (idx === -1) return moveHighlight(dir)
  if (!state.selectAnchorId) setState("selectAnchorId", state.highlightId)
  const next = Math.min(list.length - 1, Math.max(0, idx + dir))
  setState("highlightId", list[next]!.id)
}

/**
 * Enter / shift+→ in the queue: commit. A multi-selection enters merged mode
 * (one composer answering every selected message); otherwise the highlight
 * becomes current. Focus returns to the composer; the pane stays.
 */
export function commitHighlight() {
  // Roster rows never commit to the composer; ⏎ there means bind (App-level).
  if (highlightedSession()) return
  const selection = selectedIds()
  if (selection.length > 1) {
    // The merged composer INHERITS the members' existing drafts (newline-
    // separated, cursor at end) and CONSUMES them — otherwise an individual
    // draft (e.g. "asd" typed before merging) survives the merge invisibly
    // and fires the next time that message becomes current alone.
    const inherited = selection
      .map((id) => drafts.get(id)?.text ?? "")
      .filter((text) => text.trim().length > 0)
      .join("\n")
    for (const id of selection) deleteDraft(id)
    const mergedKey = selection.join("+")
    if (inherited.length > 0) setDraft(mergedKey, { text: inherited, cursor: inherited.length })
    else deleteDraft(mergedKey)
    setState({
      merged: selection,
      currentId: selection[0]!,
      focus: "composer",
      selectAnchorId: null,
    })
    return
  }
  setState({
    ...(state.highlightId ? { currentId: state.highlightId } : {}),
    merged: [],
    focus: "composer",
    selectAnchorId: null,
  })
}

/** Leave merged mode (after the merged answer is sent). */
export function clearMerged() {
  setState("merged", [])
}
