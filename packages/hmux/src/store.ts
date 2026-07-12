import { createMemo, createSignal } from "solid-js"
import type { Backend, SessionGroup, Status, WindowEntry } from "./backend"

export const [groups, setGroups] = createSignal<SessionGroup[]>([])
export const [query, setQuery] = createSignal("")
export const [selected, setSelected] = createSignal(0)

/** Modal state: list navigation, a text prompt, or a kill confirmation. */
export type Mode =
  | { kind: "list" }
  | { kind: "prompt"; label: string; initial: string; onSubmit: (text: string) => void }
  | { kind: "confirm-kill"; target: string; label: string; isWindow: boolean }
export const [mode, setMode] = createSignal<Mode>({ kind: "list" })

/**
 * One visual row. Tree view: session headers (openable) with their windows
 * indented beneath (single-window sessions collapse to just the header).
 * While typing, matches flatten into one ranked list of windows.
 */
export interface Row {
  kind: "session" | "window"
  target: string
  label: string
  dir: string
  status: Status | null
  detail: string | null
  attached: boolean
  session: string
  /**
   * A session header whose windows are listed beneath it. Its status still
   * rolls up (navigation lands here), but the glyph is left to the children —
   * showing it on both parent and window would double every signal.
   */
  expanded?: boolean
}

function sessionRow(g: SessionGroup): Row {
  return {
    kind: "session",
    target: g.target,
    label: g.name,
    dir: g.dir,
    status: g.status,
    detail: g.detail,
    attached: g.attached,
    session: g.name,
  }
}

function windowRow(w: WindowEntry, g: SessionGroup): Row {
  // Label is the tmux window name. The advertised agent identity stays out
  // of the display (too noisy) but remains searchable; pane count is not
  // shown either.
  return {
    kind: "window",
    target: w.target,
    label: w.name,
    dir: w.dir,
    status: w.status,
    detail: w.detail,
    attached: g.attached,
    session: g.name,
  }
}

/** Subsequence fuzzy match; contiguous substring scores higher. */
export function fuzzyScore(haystack: string, needle: string): number {
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  if (n.length === 0) return 1
  if (h.includes(n)) return 100 - h.indexOf(n)
  let i = 0
  for (const c of h) if (c === n[i]) i++
  return i === n.length ? 10 : -1
}

export const rows = createMemo<Row[]>(() => {
  const q = query().trim()
  if (q.length === 0) {
    const out: Row[] = []
    for (const g of groups()) {
      // A single-window session IS its window; don't repeat it. A multi-window
      // one expands, and its header defers the status glyph to the children.
      const expanded = g.windows.length > 1
      out.push({ ...sessionRow(g), expanded })
      if (expanded) for (const w of g.windows) out.push(windowRow(w, g))
    }
    return out
  }
  // Typing flattens to one ranked list: windows matched by "session window" —
  // exactly the text on screen, nothing invisible.
  const scored: Array<{ row: Row; score: number }> = []
  for (const g of groups()) {
    for (const w of g.windows) {
      const score = fuzzyScore(`${g.name} ${w.name}`, q)
      if (score >= 0) scored.push({ row: windowRow(w, g), score })
    }
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.row)
})

export function selectedRow(): Row | undefined {
  return rows()[selected()]
}

/**
 * Parked: the user hasn't moved the cursor or typed since the picker (re)set
 * it. While parked, refresh() lets the cursor follow the attached session's
 * active window — tab back to the picker and it sits on where you just were.
 * The first arrow key or typed character unparks it; browsing is never
 * yanked out from under you by a window switch elsewhere.
 */
let parked = true

export function moveSelection(delta: number) {
  const n = rows().length
  if (n === 0) return
  parked = false
  setSelected(((selected() + delta) % n + n) % n)
}

/** An agent is present here — any advertised status, however it's doing. */
function needsYou(r: Row): boolean {
  return r.status != null
}

/**
 * Left/right jump between the rows that want you — the nearest one up (-1) or
 * down (+1), wrapping. We land on the leaves: individual windows, plus the
 * single-window sessions that are their own window. An expanded session header
 * only mirrors its children's rolled-up status, so we skip it and visit those
 * windows directly — a session with several needy windows stays fully
 * reachable. While filtering, every row is already a window.
 */
export function jumpToNeedsYou(direction: 1 | -1) {
  const rs = rows()
  if (rs.length === 0) return
  const hits: number[] = []
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]
    if (r.kind === "session" && r.expanded) continue
    if (needsYou(r)) hits.push(i)
  }
  if (hits.length === 0) return
  parked = false
  const cur = selected()
  const target =
    direction === 1
      ? (hits.find((i) => i > cur) ?? hits[0])
      : ([...hits].reverse().find((i) => i < cur) ?? hits[hits.length - 1])
  setSelected(target)
}

export function updateQuery(next: string) {
  // A query never starts with whitespace: a stray space would match every
  // entry and flatten the whole tree for nothing.
  parked = false
  setQuery(next.trimStart())
  setSelected(0)
}

/**
 * Clear the typeahead and leave the cursor on `target` in the reset tree.
 * Called after entering a session: the filter starts fresh but the session
 * you just opened stays highlighted so you land back where you were.
 */
export function selectTarget(target: string) {
  // Capture the session before clearing the query: while typing, rows are
  // flattened window rows (target `name:index`), but the reset tree collapses
  // a single-window session to just its header (target `name`). Matching the
  // window target alone would miss and snap the cursor back to the top.
  const session = rows().find((r) => r.target === target)?.session
  setQuery("")
  parked = true // opening re-parks the cursor: it may follow the live window again
  const reset = rows()
  let i = reset.findIndex((r) => r.target === target)
  if (i < 0 && session) i = reset.findIndex((r) => r.session === session)
  setSelected(i < 0 ? 0 : i)
}

let backend: Backend | undefined
let generation = 0

export function setBackend(b: Backend) {
  backend = b
}

/**
 * A cursor to restore on the next populated refresh — the picker's last
 * position, read back from the backend at startup. Applied once, then dropped;
 * the live tree takes over from there.
 */
let restoreTarget: string | null = null
export function restoreSelection(target: string | null) {
  restoreTarget = target
}

export async function refresh() {
  if (!backend) return
  const gen = ++generation
  const list = await backend.list()
  if (gen !== generation) return // a newer poll superseded this one
  setGroups(list)
  if (selected() >= rows().length) setSelected(Math.max(0, rows().length - 1))
  // Restore wins the first tick it can land — memory over the live follow, and
  // only once. Later ticks fall through to following the attached window.
  if (restoreTarget && parked && query().length === 0) {
    const target = restoreTarget
    restoreTarget = null
    const reset = rows()
    const session = reset.find((r) => r.target === target)?.session ?? target
    let i = reset.findIndex((r) => r.target === target)
    if (i < 0) i = reset.findIndex((r) => r.session === session)
    if (i >= 0) {
      setSelected(i)
      return
    }
  }
  followActiveWindow()
}

/**
 * While parked (and not filtering), keep the cursor on the attached session's
 * active window — a window switch inside the live session propagates here.
 * A collapsed single-window session parks on the session header instead.
 */
function followActiveWindow() {
  if (!parked || query().length > 0) return
  const g = groups().find((s) => s.attached)
  if (!g) return
  const w = g.windows.find((win) => win.active)
  const target = g.windows.length > 1 && w ? w.target : g.target
  const i = rows().findIndex((r) => r.target === target)
  if (i >= 0) setSelected(i)
}

export function startPolling(intervalMs = 1000): () => void {
  refresh()
  const timer = setInterval(refresh, intervalMs)
  return () => clearInterval(timer)
}
