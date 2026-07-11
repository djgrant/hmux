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
  restoreSelection,
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
    // Hand the last cursor to the store before the first poll lands, so the
    // picker opens where you left it rather than at the top.
    props.backend.loadSelection().then(restoreSelection)
    const stop = startPolling(1000)
    onCleanup(stop)
  })

  // A display target that registers while the picker is up loads the current
  // selection on its own: run `mux target` in a fresh terminal and the session
  // under the cursor lands there, no keypress. Targets already parked when the
  // picker opened form the baseline — only ones that appear afterwards trigger.
  onMount(() => {
    if (props.poll === false) return
    let known: Set<string> | null = null
    const tick = async () => {
      const targets = await props.backend.targets()
      const ttys = new Set(targets.map((t) => t.tty))
      if (known === null) {
        known = ttys
        return
      }
      const row = selectedRow()
      if (row) {
        for (const t of targets) {
          if (!known.has(t.tty)) await props.backend.openInClient(row.target, t).catch(() => {})
        }
      }
      known = ttys
    }
    const timer = setInterval(tick, 1000)
    onCleanup(() => clearInterval(timer))
  })

  const open = async (target: string) => {
    // Entering a session clears the typeahead but leaves the cursor on the
    // session just opened, so the picker lands back where you were.
    selectTarget(target)
    props.backend.saveSelection(target) // outlive this picker: reopen here

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
      // Skip to the nearest window that wants you — one up on left, one down
      // on right — so a full board can be cleared without hunting.
      jumpToNeedsYou(key.name === "left" ? -1 : 1)
    } else if (key.meta && (key.name === "b" || key.name === "f")) {
      // ⌥←/⌥→ do the same jump but peek as they go, the display following the
      // selection while focus stays here (as with ⌥↑↓). iTerm's Esc+ option
      // sends these as meta-b/meta-f (emacs word motion), not modified arrows.
      jumpToNeedsYou(key.name === "b" ? -1 : 1)
      const next = selectedRow()
      if (next) peek(next.target)
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
        label: "new session — name, or session/window",
        initial: "",
        // Creating drops you straight in: birth it, then open the target it
        // reports (a session, or a window when the name carried a slash) like
        // any row — the picker selects it and loads it.
        onSubmit: async (text) => {
          const target = await props.backend.create(text)
          await refresh()
          await open(target)
        },
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
      // Persist the browsed cursor, then quit — reopening lands here.
      const target = selectedRow()?.target
      const quit = () => {
        renderer.destroy()
        process.exit(0)
      }
      if (target) props.backend.saveSelection(target).then(quit, quit)
      else quit()
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
              // An expanded session header hands its signal — glyph and detail
              // both — down to the windows that own it, so it isn't doubled.
              const signal = () => (row.expanded ? null : row.status)
              const detail = () => (row.expanded ? null : row.detail)
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
                    <span style={{ fg: statusColor(signal()) }}>
                      {indent() + statusGlyph(signal(), row.attached) + " "}
                    </span>
                    {label()}
                    <Show when={detail()}>
                      <span style={{ fg: statusColor(signal()) }}>{"  " + detail()}</span>
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
