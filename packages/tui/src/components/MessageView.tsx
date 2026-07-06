import { Show } from "solid-js"
import type { Message } from "@humans/protocol"
import { formatAge, NO_PROJECT } from "../store"

const DIM = "#7a7a7a"
const GUTTER = "#4a4a4a"

export function MessageView(props: { message: Message }) {
  return (
    <box flexGrow={1} flexDirection="column" gap={1} paddingTop={1}>
      <text fg={DIM}>
        {props.message.agent} · {props.message.project ?? NO_PROJECT} ·{" "}
        {formatAge(props.message.createdAt)}
      </text>
      <box border={["left"]} borderColor={GUTTER} paddingLeft={1} flexDirection="column" gap={1}>
        <text>{props.message.body}</text>
        <Show when={props.message.context}>
          <text fg={DIM}>{props.message.context}</text>
        </Show>
      </box>
    </box>
  )
}
