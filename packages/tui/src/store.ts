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

// Terminal-focus epoch: bumped whenever the terminal regains focus so the
// composer can re-assert textarea focus (resilience against anything having
// stolen renderable focus while the user was away).
const [focusEpoch, setFocusEpoch] = createSignal(0)
export { focusEpoch }
export function bumpFocusEpoch() {
  setFocusEpoch((e) => e + 1)
}

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
  // The raw WS message bypasses addMessage's ingress sanitization; clean it
  // here too so the banner text and the notification effect (which reads
  // `incoming`) never carry escape-sequence remnants.
  const clean = sanitizeMessage(message)
  showBanner(clean)
  setIncoming(clean)
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
 * Pending asks/notifies grouped by project (group order = first appearance,
 * oldest-first). Answered messages are not listed in the queue at all;
 * approvals live in their own sidebar section instead.
 */
export const groups = createMemo<Group[]>(() => {
  const byProject = new Map<string, Group>()
  for (const m of ordered()) {
    if (m.status !== "pending" || m.kind === "approval") continue
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

/** Pending approval requests, oldest-first — the "approvals" section. */
export const approvals = createMemo(() =>
  ordered().filter((m) => m.status === "pending" && m.kind === "approval"),
)

/**
 * Queue navigation/answer order (pending only), matching the displayed
 * order: message groups first, then the approvals section.
 */
export const pending = createMemo(() => [
  ...groups().flatMap((g) => g.messages),
  ...approvals(),
])

// --- Sessions / presence -----------------------------------------------------

/** Sessions with no heartbeat for this long are POSSIBLY dead. */
export const SESSION_STALE_MS = 90_000

/**
 * Sessions silent for this long are dropped from the roster outright. Hooks
 * only fire on prompt/tool/stop/notification — a session idle at the prompt
 * cannot heartbeat, so staleness alone must not evict it (it may be alive).
 * But kill -9 skips SessionEnd, so without a hard cutoff unkillable zombies
 * would accumulate forever.
 */
export const SESSION_DROP_MS = 4 * 60 * 60_000

/** Possibly dead: explicitly ended, or silent past the staleness threshold. */
export function sessionStale(session: Session, at = now()): boolean {
  return session.endedAt !== undefined || at - session.lastSeen > SESSION_STALE_MS
}

/**
 * The roster: every non-ended session in arrival order — INCLUDING stale
 * ones, rendered as "possibly gone" rather than hidden. Only hours-silent
 * sessions are hard-dropped.
 */
export const roster = createMemo(() =>
  state.sessions
    .filter((s) => s.endedAt === undefined && now() - s.lastSeen <= SESSION_DROP_MS)
    .sort((a, b) => a.startedAt - b.startedAt),
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

// --- Ingress sanitization ----------------------------------------------------
//
// Agent-supplied text is UNTRUSTED terminal-wise: agents routinely paste
// ANSI-colored build output into ask/notify bodies. The renderer copies text
// into cells and emits those bytes RAW in the frame stream, so an embedded
// ESC can merge with adjacent output into live escape sequences (strewn
// text, screen clears); the same text also reaches OSC egress (terminal
// title). Sanitize at the ONE choke point where server data enters the
// store, so nothing downstream has to care.
//
// Two passes: first remove COMPLETE escape sequences so colored output
// degrades to clean plain text (no "[31m" litter), then strip whatever
// stray control bytes remain (all C0 except \n, DEL, C1 — \t goes too;
// cell drawing has no tab semantics).
const ANSI_SEQUENCES_RE = new RegExp(
  [
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?", // OSC (BEL/ST-terminated, or cut off)
    "\\x1b\\[[0-9;:?]*[ -/]*[@-~]", // CSI
    "\\x9b[0-9;:?]*[ -/]*[@-~]", // C1 CSI
    "\\x1b[()*+][ -~]", // charset designation
    "\\x1b.", // any remaining ESC+single-char form (. excludes \n)
  ].join("|"),
  "g",
)
const CONTROL_CHARS_RE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g

/** Strip ANSI escape sequences and control characters (keeps \n). */
export function stripControls(text: string): string {
  return text.replace(ANSI_SEQUENCES_RE, "").replace(CONTROL_CHARS_RE, "")
}

const sanitizeOptional = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : stripControls(text)

function sanitizeMessage(m: Message): Message {
  return {
    ...m,
    agent: stripControls(m.agent),
    project: sanitizeOptional(m.project),
    body: stripControls(m.body),
    context: sanitizeOptional(m.context),
    suggestion: sanitizeOptional(m.suggestion),
    answer: sanitizeOptional(m.answer),
  }
}

function sanitizeSession(s: Session): Session {
  return {
    ...s,
    agent: stripControls(s.agent),
    project: sanitizeOptional(s.project),
    model: sanitizeOptional(s.model),
    detail: sanitizeOptional(s.detail),
  }
}

export function applyInit(messages: Message[], sessions: Session[] = []) {
  setState("messages", messages.map(sanitizeMessage))
  setState("sessions", sessions.map(sanitizeSession))
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
  const clean = sanitizeSession(session)
  setState("sessions", (list) => {
    const idx = list.findIndex((s) => s.id === clean.id)
    return idx === -1 ? [...list, clean] : list.map((s, i) => (i === idx ? clean : s))
  })
}

export function addMessage(message: Message) {
  if (state.messages.some((m) => m.id === message.id)) return
  setState("messages", state.messages.length, sanitizeMessage(message))
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
  // A selection never crosses the messages/approvals boundary: one merged
  // answer must not mix "allow" semantics with free-text replies.
  if ((list[idx]!.kind === "approval") !== (list[next]!.kind === "approval")) return
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
    // The merged composer SEEDS from the members' drafts (newline-separated,
    // cursor at end) but COPIES rather than consumes: backing out of an
    // accidental merge loses nothing — each member keeps its own draft.
    // Re-entering an existing merge keeps the merged draft (it wins by
    // default); ctrl+u in the merged composer re-copies from the members.
    // Member drafts are only cleaned up when the merged answer is SENT.
    const mergedKey = selection.join("+")
    if (!drafts.has(mergedKey)) {
      const inherited = mergedDraftFor(selection)
      if (inherited.length > 0)
        setDraft(mergedKey, { text: inherited, cursor: inherited.length })
    }
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

/** The members' current drafts concatenated — the merged composer's seed. */
function mergedDraftFor(ids: string[]): string {
  return ids
    .map((id) => drafts.get(id)?.text ?? "")
    .filter((text) => text.trim().length > 0)
    .join("\n")
}

/** ctrl+u in the merged composer: re-copy the members' CURRENT drafts. */
export function mergedDraftFromMembers(): string {
  return mergedDraftFor(state.merged)
}
