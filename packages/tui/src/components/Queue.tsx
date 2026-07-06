import { For } from "solid-js"
import type { Message } from "@humans/protocol"
import { formatAge, groups, state } from "../store"

const DIM = "#7a7a7a"
const FAINT = "#555555"
const HIGHLIGHT_BG = "#2e2e2e"

function snippet(m: Message): string {
  const words = m.body.replace(/\s+/g, " ").trim().split(" ")
  const head = words.slice(0, 5).join(" ")
  return words.length > 5 ? `${head}…` : head
}

function Row(props: { message: Message }) {
  const highlighted = () => props.message.id === state.highlightId
  const answered = () => props.message.status === "answered"
  return (
    <box backgroundColor={highlighted() ? HIGHLIGHT_BG : undefined} paddingLeft={1}>
      <text fg={answered() ? FAINT : undefined}>
        {answered() ? "✓ " : "  "}
        {props.message.agent}
        <span style={{ fg: answered() ? FAINT : DIM }}>
          {"  "}
          {formatAge(props.message.createdAt)}
          {"  "}
          {snippet(props.message)}
        </span>
      </text>
    </box>
  )
}

export function Queue() {
  return (
    <box flexDirection="column" width="40%" paddingTop={1} paddingRight={2}>
      <For each={groups()}>
        {(group) => (
          <box flexDirection="column" marginBottom={1}>
            <text fg={FAINT}>{group.project}</text>
            <For each={group.messages}>{(m) => <Row message={m} />}</For>
          </box>
        )}
      </For>
    </box>
  )
}
