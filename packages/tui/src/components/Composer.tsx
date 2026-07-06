import { Show } from "solid-js"
import type { KeyBinding, KeyEvent, TextareaRenderable } from "@opentui/core"
import { drafts, openQueue } from "../store"

const BORDER = "#4a4a4a"

const KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
]

export function Composer(props: {
  messageId: string
  focused: boolean
  onSend: (text: string) => void
  onSkip: () => void
}) {
  return (
    <Show when={props.messageId} keyed>
      {(id) => {
        let ref: TextareaRenderable | undefined
        return (
          <box border borderColor={BORDER} paddingLeft={1} paddingRight={1}>
            <textarea
              ref={(r: TextareaRenderable) => {
                ref = r
                if (props.focused) queueMicrotask(() => r.focus())
              }}
              focused={props.focused}
              initialValue={drafts.get(id) ?? ""}
              placeholder="reply…"
              minHeight={1}
              maxHeight={6}
              keyBindings={KEY_BINDINGS}
              onContentChange={() => {
                if (ref) drafts.set(id, ref.plainText)
              }}
              onSubmit={() => {
                const text = ref?.plainText ?? ""
                if (text.trim().length === 0) return
                props.onSend(text)
              }}
              onKeyDown={(key: KeyEvent) => {
                if (key.shift && (key.name === "up" || key.name === "down")) {
                  key.preventDefault()
                  openQueue(key.name === "down" ? 1 : -1)
                } else if (key.name === "escape") {
                  key.preventDefault()
                  props.onSkip()
                }
              }}
            />
          </box>
        )
      }}
    </Show>
  )
}
