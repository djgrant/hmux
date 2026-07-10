import { createSignal } from "solid-js"
import { listSessions, peek, type Session } from "./tmux"

export const [sessions, setSessions] = createSignal<Session[]>([])
export const [selected, setSelected] = createSignal(0)
export const [preview, setPreview] = createSignal<string[]>([])

/** Modal state: list navigation, a text prompt, or a kill confirmation. */
export type Mode =
  | { kind: "list" }
  | { kind: "prompt"; label: string; initial: string; onSubmit: (text: string) => void }
  | { kind: "confirm-kill"; session: string }
export const [mode, setMode] = createSignal<Mode>({ kind: "list" })

export function selectedSession(): Session | undefined {
  return sessions()[selected()]
}

export function moveSelection(delta: number) {
  const n = sessions().length
  if (n === 0) return
  setSelected(((selected() + delta) % n + n) % n)
}

let generation = 0

/** One poll: session list + preview of the selected session. */
export async function refresh() {
  const gen = ++generation
  const list = await listSessions()
  if (gen !== generation) return // a newer poll superseded this one
  setSessions(list)
  if (selected() >= list.length) setSelected(Math.max(0, list.length - 1))
  const current = list[selected()]
  setPreview(current ? await peek(current.name) : [])
}

export function startPolling(intervalMs = 1000): () => void {
  refresh()
  const timer = setInterval(refresh, intervalMs)
  return () => clearInterval(timer)
}
