import { For, Show, onCleanup, onMount } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import {
  mode,
  moveSelection,
  preview,
  refresh,
  selected,
  selectedSession,
  sessions,
  setMode,
  startPolling,
} from "./store"
import {
  attachBlocking,
  insideTmux,
  killSession,
  newSession,
  renameSession,
  switchClient,
} from "./tmux"
import {
  BODY,
  BRIGHT,
  DIM,
  FAINT,
  GUTTER,
  HIGHLIGHT_BG,
  MAIN_BG,
  SIDEBAR_BG,
  statusColor,
  statusGlyph,
} from "./theme"

const SIDEBAR_WIDTH = 44

export function App(props: {
  /** Disable the tmux poll loop (tests inject store state directly). */
  poll?: boolean
}) {
  const renderer = useRenderer()

  onMount(() => {
    if (props.poll === false) return
    const stop = startPolling(1000)
    onCleanup(stop)
  })

  const open = async (name: string) => {
    if (insideTmux()) {
      // The router keeps running in its own pane; this client just retargets.
      await switchClient(name)
      return
    }
    // Hand the terminal over to a full attach; resume when the user detaches.
    renderer.suspend()
    attachBlocking(name)
    renderer.resume()
    refresh()
  }

  useKeyboard((key) => {
    const m = mode()
    if (m.kind === "confirm-kill") {
      key.preventDefault()
      if (key.name === "y") {
        killSession(m.session).then(refresh)
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
    const session = selectedSession()
    if (key.name === "up" || key.name === "k") {
      moveSelection(-1)
    } else if (key.name === "down" || key.name === "j") {
      moveSelection(1)
    } else if (key.name === "return" && session) {
      key.preventDefault()
      open(session.name)
    } else if (key.name === "n") {
      setMode({
        kind: "prompt",
        label: "new session name",
        initial: "",
        onSubmit: (text) => newSession(text).then(refresh),
      })
    } else if (key.name === "r" && session) {
      setMode({
        kind: "prompt",
        label: `rename ${session.name}`,
        initial: session.name,
        onSubmit: (text) => renameSession(session.name, text).then(refresh),
      })
    } else if (key.name === "x" && session) {
      setMode({ kind: "confirm-kill", session: session.name })
    } else if (key.name === "q") {
      renderer.destroy()
      process.exit(0)
    }
  })

  return (
    <box flexDirection="row" height="100%" backgroundColor={MAIN_BG}>
      {/* Session list */}
      <box
        flexDirection="column"
        width={SIDEBAR_WIDTH}
        flexShrink={0}
        backgroundColor={SIDEBAR_BG}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={1}
      >
        <text fg={DIM}>tmux sessions</text>
        <box height={1} />
        <Show when={sessions().length > 0} fallback={<text fg={FAINT}>no server running</text>}>
          <For each={sessions()}>
            {(s, i) => {
              const isSelected = () => i() === selected()
              return (
                <box
                  flexDirection="column"
                  backgroundColor={isSelected() ? HIGHLIGHT_BG : SIDEBAR_BG}
                  paddingLeft={1}
                >
                  <box flexDirection="row">
                    <text fg={statusColor(s.status)}>{statusGlyph(s.status, s.attached)} </text>
                    <text wrapMode="none" truncate fg={isSelected() ? BRIGHT : BODY}>
                      {s.name}
                    </text>
                  </box>
                  <text wrapMode="none" truncate fg={FAINT}>
                    {"  "}{s.dir}
                  </text>
                  <Show when={s.detail}>
                    <text wrapMode="none" truncate fg={statusColor(s.status)}>
                      {"  " + s.detail}
                    </text>
                  </Show>
                </box>
              )
            }}
          </For>
        </Show>
        <box flexGrow={1} />
        <text fg={FAINT}>⏎ open · n new · r rename · x kill · q quit</text>
        <box height={1} />
      </box>

      {/* Peek pane: last screenful of the selected session's active pane */}
      <box flexDirection="column" flexGrow={1} minWidth={0} paddingTop={1} paddingLeft={2} paddingRight={1}>
        <Show when={selectedSession()} keyed>
          {(s) => (
            <>
              <text fg={DIM}>
                {s.name} · {s.windows} window{s.windows === 1 ? "" : "s"} ·{" "}
                {s.attached ? "attached" : "detached"}
                {s.status ? ` · ${s.status}` : ""}
              </text>
              <box height={1} />
              <box flexGrow={1} minHeight={0} flexDirection="column">
                <For each={preview()}>
                  {(line) => (
                    <text wrapMode="none" truncate fg={FAINT}>
                      {line || " "}
                    </text>
                  )}
                </For>
              </box>
            </>
          )}
        </Show>
      </box>

      {/* Prompt overlay (new / rename) */}
      <Show
        when={mode().kind === "prompt" ? (mode() as Extract<ReturnType<typeof mode>, { kind: "prompt" }>) : null}
        keyed
      >
        {(m) => (
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
            {(() => {
              let ref: TextareaRenderable | undefined
              return (
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
              )
            })()}
            <text fg={FAINT}>⏎ confirm · esc cancel</text>
          </box>
        )}
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
