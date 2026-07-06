import { Show } from "solid-js"
import { position, state } from "../store"

const DIM = "#7a7a7a"

export function Footer() {
  const hint = () =>
    state.mode === "queue"
      ? " ↑↓ move · ⏎ compose · esc close"
      : ` ⏎ send · shift+↑↓ queue · esc skip · ${position().n}/${position().m}`
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={DIM}>{hint()}</text>
      <Show when={state.conn !== "open"}>
        <text fg={DIM}>reconnecting… </text>
      </Show>
    </box>
  )
}
