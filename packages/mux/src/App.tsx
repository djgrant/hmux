import { For, Show, onCleanup, onMount } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import type { Backend } from "./backend"
import {
  jumpToNeedsYou,
  mode,
  moveSelection,
  query,
  refresh,
  rows,
  selected,
  selectedRow,
  selectTarget,
  setMode,
  setSelected,
  startPolling,
  updateQuery,
} from "./store"
import {
  BODY,
  BRIGHT,
  DIM,
  FAINT,
  GUTTER,
  HIGHLIGHT_BG,
  MAIN_BG,
  statusColor,
  statusGlyph,
} from "./theme"

export function App(props: {
  backend: Backend
  /** Disable the poll loop (tests inject store state directly). */
  poll?: boolean
}) {
  const renderer = useRenderer()

  onMount(() => {
    if (props.poll === false) return
    const stop = startPolling(1000)
    onCleanup(stop)
  })

  const open = async (target: string) => {
    // Entering a session clears the typeahead but leaves the cursor on the
    // session just opened, so the picker lands back where you were.
    selectTarget(target)
    // A live display target (another terminal running `mux target`) takes
    // priority: load the session there, the picker stays on screen.
    const targets = await props.backend.targets()
    if (targets.length > 0) {
      await props.backend.openInClient(target, targets[0])
      return
    }
    if (props.backend.opensInPlace()) {
      await props.backend.open(target)
      return
    }
    // Hand the terminal to the session; come back here on detach (prefix d).
    renderer.suspend()
    await props.backend.open(target)
    renderer.resume()
    refresh()
  }

  // Peek: load the selection into the display target without taking focus.
  // Disabled for control-mode targets — every switch there tears down and
  // rebuilds native windows, far too much churn to ride the arrow keys.
  const peek = async (target: string) => {
    const [t] = await props.backend.targets()
    if (!t || t.controlMode) return
    await props.backend.peekInClient(target, t)
  }

  useKeyboard((key) => {
    const m = mode()
    if (m.kind === "confirm-kill") {
      key.preventDefault()
      if (key.name === "y") {
        props.backend.kill(m.target).then(refresh)
        setMode({ kind: "list" })
      } else if (key.name !== "return") {
        setMode({ kind: "list" })
      }
      return
    }
    if (m.kind === "prompt") {
      // Escape backs out; everything else belongs to the textarea.
      if (key.name === "escape") {
        key.preventDefault()
        setMode({ kind: "list" })
      }
      return
    }

    const row = selectedRow()
    if (key.name === "up" || key.name === "down") {
      moveSelection(key.name === "up" ? -1 : 1)
      // Held option turns browsing into peeking: the display target follows
      // the selection while focus stays here. (Not ctrl: macOS reserves
      // ctrl+arrows for Mission Control, the terminal never sees them.)
      if (key.option || key.meta || key.ctrl) {
        const next = selectedRow()
        if (next) peek(next.target)
      }
    } else if (key.name === "left" || key.name === "right") {
      // Skip to the nearest session that isn't working — one up on left, one
      // down on right — so a full board can be cleared without hunting.
      jumpToNeedsYou(key.name === "left" ? -1 : 1)
    } else if (key.name === "return" && row) {
      key.preventDefault()
      open(row.target)
    } else if (key.name === "escape") {
      // Clearing the filter keeps the cursor on the current row rather than
      // snapping back to the top of the reset tree.
      if (row) selectTarget(row.target)
      else updateQuery("")
    } else if (key.name === "backspace") {
      updateQuery(query().slice(0, -1))
    } else if (key.ctrl && key.name === "n") {
      setMode({
        kind: "prompt",
        label: "new session name",
        initial: "",
        onSubmit: (text) => props.backend.create(text).then(refresh),
      })
    } else if (key.ctrl && key.name === "r" && row) {
      // Renames the row under the cursor: session rows rename the session,
      // window rows the window.
      setMode({
        kind: "prompt",
        label: `rename ${row.kind === "window" ? "window" : "session"} ${row.label}`,
        initial: row.label,
        onSubmit: (text) => props.backend.rename(row.target, text).then(refresh),
      })
    } else if (key.ctrl && key.name === "x" && row) {
      // Kills the row under the cursor: window rows kill just that window,
      // session rows the whole session (mirrors ^r rename's target routing).
      setMode({ kind: "confirm-kill", target: row.target, label: row.label, isWindow: row.kind === "window" })
    } else if (key.ctrl && key.name === "c") {
      renderer.destroy()
      process.exit(0)
    } else if (!key.ctrl && !key.meta && key.sequence && /^[\x20-\x7e]$/.test(key.sequence)) {
      // Typeahead: any printable character filters.
      updateQuery(query() + key.sequence)
    }
  })

  return (
    <box flexDirection="column" height="100%" backgroundColor={MAIN_BG} paddingTop={1} paddingLeft={2} paddingRight={2}>
      {/* Typeahead query, framed so it reads as an input */}
      <box border borderColor={GUTTER} flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text wrapMode="none" truncate fg={query().length > 0 ? BRIGHT : FAINT}>
          {query() || "filter"}
        </text>
      </box>
      <box height={1} />

      {/* Two-tier list (flattens to ranked windows while typing) */}
      <box flexGrow={1} minHeight={0} flexDirection="column" overflow="hidden">
        <Show
          when={rows().length > 0}
          fallback={
            <text fg={FAINT}>
              {query().length > 0 ? "no matches" : "no sessions — ^n to create one"}
            </text>
          }
        >
          <For each={rows()}>
            {(row, i) => {
              const isSelected = () => i() === selected()
              const indent = () => (row.kind === "window" && query().length === 0 ? "    " : "")
              const label = () =>
                row.kind === "window" && query().length > 0
                  ? `${row.session} · ${row.label}`
                  : row.label
              return (
                <box
                  flexDirection="row"
                  flexShrink={0}
                  backgroundColor={isSelected() ? HIGHLIGHT_BG : undefined}
                  paddingLeft={1}
                  onMouseDown={() => {
                    setSelected(i())
                    open(row.target)
                  }}
                >
                  <text wrapMode="none" truncate fg={isSelected() ? BRIGHT : row.kind === "session" ? BODY : DIM}>
                    <span style={{ fg: statusColor(row.status) }}>
                      {indent() + statusGlyph(row.status, row.attached) + " "}
                    </span>
                    {label()}
                    <Show when={row.detail}>
                      <span style={{ fg: statusColor(row.status) }}>{"  " + row.detail}</span>
                    </Show>
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>

      {/* Footer */}
      <box flexShrink={0}>
        <text wrapMode="none" truncate fg={FAINT}>
          ⏎ open · ⌥↑↓ peek · ←→ needs you · ^n new · ^r rename · ^x kill
        </text>
      </box>

      {/* Prompt overlay (new / rename) */}
      <Show
        when={mode().kind === "prompt" ? (mode() as Extract<ReturnType<typeof mode>, { kind: "prompt" }>) : null}
        keyed
      >
        {(m) => {
          let ref: TextareaRenderable | undefined
          return (
            <box
              position="absolute"
              top={2}
              left={4}
              width={40}
              flexDirection="column"
              border
              borderColor={GUTTER}
              backgroundColor={MAIN_BG}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={DIM}>{m.label}</text>
              <textarea
                ref={(r: TextareaRenderable) => {
                  ref = r
                  queueMicrotask(() => {
                    r.focus()
                    r.cursorOffset = r.plainText.length // edit from the end, not over the start
                  })
                }}
                focused
                initialValue={m.initial}
                keyBindings={[{ name: "return", action: "submit" }]}
                minHeight={1}
                maxHeight={1}
                textColor={BODY}
                onSubmit={() => {
                  const text = ref?.plainText.trim() ?? ""
                  setMode({ kind: "list" })
                  if (text) m.onSubmit(text)
                }}
              />
              <text fg={FAINT}>⏎ confirm · esc cancel</text>
            </box>
          )
        }}
      </Show>

      {/* Kill confirmation */}
      <Show
        when={mode().kind === "confirm-kill" ? (mode() as Extract<ReturnType<typeof mode>, { kind: "confirm-kill" }>) : null}
        keyed
      >
        {(m) => (
          <box
            position="absolute"
            top={2}
            left={4}
            border
            borderColor={GUTTER}
            backgroundColor={MAIN_BG}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={BODY}>kill {m.isWindow ? "window" : "session"} {m.label}? y / any key to cancel</text>
          </box>
        )}
      </Show>
    </box>
  )
}
