import { highlightedSession, position, state } from "../store"
import { DIM } from "../theme"

export function Footer() {
  // Minimal, left-aligned; the n/N counter leads. Composer-focused: teach
  // the queue entry key (shift+↑↓ — the whole navigation surface).
  // Queue-focused: movement/selection/answer hints; roster rows swap in bind.
  const hint = () => {
    const reconnect = state.conn !== "open" ? "reconnecting… · " : ""
    const keys =
      state.focus === "queue"
        ? highlightedSession()
          ? "↑↓ move · ⏎ bind/unbind"
          : "↑↓ move · shift+↑↓ select · ⏎ answer"
        : "shift+↑↓"
    return `${position().n}/${position().m} · ${reconnect}${keys}`
  }
  return (
    // flexShrink=0: a long message must squeeze the body scrollbox, never
    // the footer row.
    <box flexDirection="row" justifyContent="flex-start" flexShrink={0}>
      <text fg={DIM}>{hint()}</text>
    </box>
  )
}
