import { Show } from "solid-js"
import type { KeyBinding, KeyEvent, TextareaRenderable } from "@opentui/core"
import { cycleCurrent, drafts, focusQueue, setComposerEmpty, setDraft } from "../store"
import { BODY, FAINT, GUTTER, GUTTER_FADED } from "../theme"

// Plain ⏎ is the ONLY submit; every modified return means newline.
// - shift+return arrives as-is only under the kitty protocol (CSI 13;2u) or
//   modifyOtherKeys (CSI 27;2;13~); both parse to {name:"return", shift}.
// - Legacy terminals can't encode shift+return at all, so the ecosystem
//   convention (Ghostty/iTerm keybinds à la Claude Code, tmux bindings) maps
//   shift+enter to send ESC CR — which parses as {name:"return", meta}.
//   OpenTUI's DEFAULT textarea bindings map meta+return to submit, so
//   without these overrides that convention SENDS the message instead of
//   newlining. Same override for the keypad-enter variant.
const KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "kpenter", meta: true, action: "newline" },
]

export function Composer(props: {
  messageId: string
  focused: boolean
  /** Agent-provided suggested answer; the ghost defaults to "ok" without one. */
  suggestion?: string
  onSend: (text: string) => void
}) {
  const ghost = () => props.suggestion ?? "ok"
  return (
    <Show when={props.messageId} keyed>
      {(id) => {
        let ref: TextareaRenderable | undefined
        const empty = () => (ref?.plainText ?? drafts.get(id)?.text ?? "").length === 0
        const saveDraft = () => {
          if (ref) setDraft(id, { text: ref.plainText, cursor: ref.cursorOffset })
        }
        queueMicrotask(() => setComposerEmpty(empty()))
        return (
          <box
            border
            borderColor={props.focused ? GUTTER : GUTTER_FADED}
            paddingLeft={1}
            paddingRight={1}
            // Pinned: the message scrollbox above absorbs ALL vertical
            // squeeze; the composer must never be crushed by a long message.
            flexShrink={0}
          >
            {/* The ghost suggestion rides the placeholder: visible only while
                the composer is empty, faint, and accepted with tab. A bar
                ("line") cursor instead of the default block keeps the ghost's
                first character readable without a leading-space hack — so the
                interior padding stays symmetric in every state. */}
            <textarea
              ref={(r: TextareaRenderable) => {
                ref = r
                const draft = drafts.get(id)
                queueMicrotask(() => {
                  if (props.focused) r.focus()
                  // Restore the saved cursor position for this message.
                  if (draft && draft.cursor > 0) r.cursorOffset = draft.cursor
                })
              }}
              focused={props.focused}
              initialValue={drafts.get(id)?.text ?? ""}
              placeholder={ghost()}
              placeholderColor={FAINT}
              cursorStyle={{ style: "line", blinking: true }}
              textColor={props.focused ? BODY : FAINT}
              minHeight={1}
              maxHeight={6}
              keyBindings={KEY_BINDINGS}
              onContentChange={() => {
                // Plain Map write per keystroke; only the empty/non-empty
                // transition touches a signal.
                if (!ref) return
                saveDraft()
                setComposerEmpty(ref.plainText.length === 0)
              }}
              onCursorChange={() => {
                // Cursor-only movements must persist too.
                saveDraft()
              }}
              onSubmit={() => {
                if (!ref) return
                const text = ref.plainText
                // Enter on an empty composer does nothing; accept the ghost
                // with tab instead.
                if (text.trim().length === 0) return
                props.onSend(text)
              }}
              onKeyDown={(key: KeyEvent) => {
                // shift+↑↓ switches the current message IN PLACE: focus never
                // leaves the composer; the keyed remount swaps in the next
                // message's draft and re-asserts textarea focus. The
                // preventDefault is load-bearing — the remounted textarea
                // registers on the KeyHandler that is mid-emit for THIS
                // event and would otherwise receive it. Inside the queue,
                // shift+↑↓ means selection instead (handled in App.tsx), so
                // the semantics never collide.
                if (key.shift && (key.name === "up" || key.name === "down")) {
                  key.preventDefault()
                  cycleCurrent(key.name === "down" ? 1 : -1)
                } else if (key.shift && key.name === "left") {
                  // shift+← is the deliberate way into the queue: focuses it
                  // at the current highlight without moving it (shift+→ from
                  // the queue mirrors back).
                  key.preventDefault()
                  focusQueue(0)
                } else if (key.name === "tab") {
                  // Tab's only job: accept the ghost on an empty composer.
                  // Always preventDefault so it can't leak into the textarea
                  // as an indent character; on a non-empty composer it does
                  // nothing.
                  key.preventDefault()
                  if (empty()) {
                    ref?.setText(ghost())
                    ref?.gotoBufferEnd()
                    setDraft(id, { text: ghost(), cursor: ghost().length })
                    setComposerEmpty(false)
                  }
                }
              }}
            />
          </box>
        )
      }}
    </Show>
  )
}
