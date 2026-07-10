import { For, Show, onCleanup, onMount } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import type { Backend } from "./backend"
import {
  mode,
  moveSelection,
  query,
  refresh,
  rows,
  selected,
  selectedRow,
  setMode,
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

  useKeyboard((key) => {
    const m = mode()
    if (m.kind === "confirm-kill") {
      key.preventDefault()
      if (key.name === "y") {
        props.backend.kill(m.session).then(refresh)
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
    if (key.name === "up") {
      moveSelection(-1)
    } else if (key.name === "down") {
      moveSelection(1)
    } else if (key.name === "return" && row) {
      key.preventDefault()
      open(row.target)
    } else if (key.name === "escape") {
      updateQuery("")
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
      setMode({
        kind: "prompt",
        label: `rename ${row.session}`,
        initial: row.session,
        onSubmit: (text) => props.backend.rename(row.session, text).then(refresh),
      })
    } else if (key.ctrl && key.name === "x" && row) {
      setMode({ kind: "confirm-kill", session: row.session })
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
      {/* Header: title + typeahead query */}
      <box flexDirection="row">
        <text fg={DIM}>mux</text>
        <Show when={query().length > 0}>
          <text fg={BRIGHT}>{"   / " + query()}</text>
        </Show>
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
                >
                  <text wrapMode="none" truncate fg={isSelected() ? BRIGHT : row.kind === "session" ? BODY : DIM}>
                    <span style={{ fg: statusColor(row.status) }}>
                      {indent() + statusGlyph(row.status, row.attached) + " "}
                    </span>
                    {label()}
                    <Show when={row.meta}>
                      <span style={{ fg: isSelected() ? BODY : DIM }}>{"  " + row.meta}</span>
                    </Show>
                    <span style={{ fg: isSelected() ? DIM : FAINT }}>{"  " + row.dir}</span>
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
          type to filter · ⏎ open · ^n new · ^r rename · ^x kill · ^c quit — inside a session, prefix d returns here
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
                  queueMicrotask(() => r.focus())
                }}
                focused
                initialValue={m.initial}
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
            <text fg={BODY}>kill session {m.session}? y / any key to cancel</text>
          </box>
        )}
      </Show>
    </box>
  )
}
