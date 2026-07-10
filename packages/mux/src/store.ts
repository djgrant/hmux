import { createMemo, createSignal } from "solid-js"
import type { Backend, SessionGroup, Status, WindowEntry } from "./backend"

export const [groups, setGroups] = createSignal<SessionGroup[]>([])
export const [query, setQuery] = createSignal("")
export const [selected, setSelected] = createSignal(0)

/** Modal state: list navigation, a text prompt, or a kill confirmation. */
export type Mode =
  | { kind: "list" }
  | { kind: "prompt"; label: string; initial: string; onSubmit: (text: string) => void }
  | { kind: "confirm-kill"; session: string }
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
      out.push(sessionRow(g))
      // A single-window session IS its window; don't repeat it.
      if (g.windows.length > 1) for (const w of g.windows) out.push(windowRow(w, g))
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

export function moveSelection(delta: number) {
  const n = rows().length
  if (n === 0) return
  setSelected(((selected() + delta) % n + n) % n)
}

export function updateQuery(next: string) {
  // A query never starts with whitespace: a stray space would match every
  // entry and flatten the whole tree for nothing.
  setQuery(next.trimStart())
  setSelected(0)
}

let backend: Backend | undefined
let generation = 0

export function setBackend(b: Backend) {
  backend = b
}

export async function refresh() {
  if (!backend) return
  const gen = ++generation
  const list = await backend.list()
  if (gen !== generation) return // a newer poll superseded this one
  setGroups(list)
  if (selected() >= rows().length) setSelected(Math.max(0, rows().length - 1))
}

export function startPolling(intervalMs = 1000): () => void {
  refresh()
  const timer = setInterval(refresh, intervalMs)
  return () => clearInterval(timer)
}
