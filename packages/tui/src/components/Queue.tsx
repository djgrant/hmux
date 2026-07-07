import { For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { Message, Session } from "@humans/protocol"
import {
  approvals,
  formatAge,
  groups,
  presenceOf,
  roster,
  selectedIds,
  sessionStale,
  state,
} from "../store"
import {
  ACCENT,
  ATTENTION,
  BODY,
  BRIGHT,
  DIM,
  FAINT,
  HIGHLIGHT_BG,
  HIGHLIGHT_BG_MUTED,
  LIVE,
  SIDEBAR_BG,
} from "../theme"

function snippet(m: Message): string {
  // First non-empty line only: multi-line bodies (approval input fences,
  // ask context paragraphs) must not leak markdown noise into the row.
  const lines = m.body.split("\n")
  const firstIdx = lines.findIndex((l) => l.trim().length > 0)
  const first = (lines[firstIdx] ?? "").replace(/\s+/g, " ").trim()
  const words = first.split(" ")
  const head = words.slice(0, 5).join(" ")
  const more =
    words.length > 5 || lines.slice(firstIdx + 1).some((l) => l.trim().length > 0)
  return more ? `${head}…` : head
}

function Row(props: { message: Message }) {
  // Shift-selected rows share the highlight background with the highlight row.
  const highlighted = () =>
    props.message.id === state.highlightId || selectedIds().includes(props.message.id)
  const queueFocused = () => state.focus === "queue"
  const presence = () => presenceOf(props.message)
  // Zombie ask: pending message whose session is ended/stale — drop a shade.
  const zombie = () => presence() === "dead"
  // Focused queue: rows brighten and the highlight/selection is a full-row
  // block with white text. Composer focused: rows drop a shade, muted bg.
  const bg = () =>
    highlighted() ? (queueFocused() ? HIGHLIGHT_BG : HIGHLIGHT_BG_MUTED) : undefined
  const fg = () => {
    if (highlighted() && queueFocused()) return BRIGHT
    if (zombie()) return queueFocused() ? DIM : FAINT
    return queueFocused() ? BODY : DIM
  }
  const metaFg = () => {
    if (highlighted() && queueFocused()) return BRIGHT
    if (zombie()) return FAINT
    return queueFocused() ? DIM : FAINT
  }
  // Presence marker column (2 cells, keeps agent names aligned): live agent
  // gets a green dot, needs-attention the accent, known-dead a faint hollow
  // marker, no matching session nothing at all.
  const marker = () => {
    switch (presence()) {
      case "live":
        return { text: "● ", fg: LIVE }
      case "attention":
        return { text: "● ", fg: ATTENTION }
      case "dead":
        return { text: "○ ", fg: FAINT }
      default:
        return { text: "  ", fg: fg() }
    }
  }
  return (
    // Rows span the full sidebar width so the highlight/selection paint runs
    // flush from the terminal's left edge to the main pane; only the text
    // keeps inner padding. paddingLeft 1 + the 2-cell marker column keeps the
    // agent name at the same column (3) as before markers existed.
    <box backgroundColor={bg()} paddingLeft={1} paddingRight={2}>
      {/* wrapMode none + truncate: long rows clip instead of wrapping or
          stretching the pane. */}
      <text wrapMode="none" truncate fg={fg()}>
        <span style={{ fg: marker().fg }}>{marker().text}</span>
        {props.message.agent}
        <span style={{ fg: metaFg() }}>
          {"  "}
          {formatAge(props.message.createdAt)}
          {"  "}
          {snippet(props.message)}
        </span>
      </text>
    </box>
  )
}

function RosterRow(props: { session: Session }) {
  const highlighted = () => props.session.id === state.highlightId
  const queueFocused = () => state.focus === "queue"
  // Stale = no heartbeat past the threshold: "possibly gone". An idle-at-the-
  // prompt session can't heartbeat (hooks fire on activity only), so it stays
  // listed — hollow marker + idle age, one shade down — instead of vanishing.
  const stale = () => sessionStale(props.session)
  const bg = () =>
    highlighted() ? (queueFocused() ? HIGHLIGHT_BG : HIGHLIGHT_BG_MUTED) : undefined
  const fg = () => {
    if (highlighted() && queueFocused()) return BRIGHT
    if (stale()) return queueFocused() ? DIM : FAINT
    return queueFocused() ? BODY : DIM
  }
  const metaFg = () => {
    if (highlighted() && queueFocused()) return BRIGHT
    if (stale()) return FAINT
    return queueFocused() ? DIM : FAINT
  }
  // Status marker: working green, needs-attention amber, idle faint; stale
  // sessions get the same faint hollow marker as dead presence.
  const marker = () => {
    if (stale()) return { text: "○ ", fg: FAINT }
    if (props.session.status === "needs-attention") return { text: "● ", fg: ATTENTION }
    return { text: "● ", fg: props.session.status === "working" ? LIVE : FAINT }
  }
  const statusText = () => {
    if (stale() || props.session.status === "idle")
      return `idle ${formatAge(props.session.lastSeen)}`
    return props.session.status === "needs-attention" ? "blocked" : "working"
  }
  // Second line: WHY the session is blocked (the permission-prompt text).
  // Only while needs-attention and fresh — the server clears detail on any
  // other status, and a stale session's old reason is just noise.
  const detail = () =>
    !stale() && props.session.status === "needs-attention" ? props.session.detail : undefined
  return (
    <box backgroundColor={bg()} paddingLeft={1} paddingRight={2} flexDirection="column">
      <text wrapMode="none" truncate fg={fg()}>
        <span style={{ fg: marker().fg }}>{marker().text}</span>
        {props.session.agent}
        <span style={{ fg: metaFg() }}>
          {"  "}
          {statusText()}
        </span>
        {props.session.bound ? <span style={{ fg: ACCENT }}>{"  ⁘ bound"}</span> : null}
      </text>
      <Show when={detail()} keyed>
        {(reason) => (
          <box paddingLeft={2}>
            <text wrapMode="none" truncate fg={highlighted() && queueFocused() ? DIM : FAINT}>
              {reason}
            </text>
          </box>
        )}
      </Show>
    </box>
  )
}

export function Queue() {
  const dimensions = useTerminalDimensions()
  // Responsive: ~30% of the terminal, clamped to [30, 48] columns. flexShrink 0
  // plus row truncation keeps the split perfectly stable.
  const width = () => Math.min(48, Math.max(30, Math.round(dimensions().width * 0.3)))
  return (
    // The sidebar is painted edge to edge: it stretches to the full row
    // height (top to the very last terminal row) from column 0, with NO
    // horizontal padding on the pane itself — rows own their text padding so
    // highlight/selection paint reaches both edges. Both section headings are
    // always visible; an empty section shows its faint bracket line instead
    // of content.
    <box
      flexDirection="column"
      width={width()}
      flexShrink={0}
      flexGrow={0}
      alignSelf="stretch"
      backgroundColor={SIDEBAR_BG}
      paddingTop={1}
    >
      <SectionHeading label="messages" />
      <Show when={groups().length > 0} fallback={<EmptyLine label="[no new messages]" />}>
        <For each={groups()}>
          {(group) => (
            <box flexDirection="column" marginBottom={1}>
              <box paddingLeft={2} paddingRight={2}>
                <text wrapMode="none" truncate fg={state.focus === "queue" ? DIM : FAINT}>
                  {group.project}
                </text>
              </box>
              <For each={group.messages}>{(m) => <Row message={m} />}</For>
            </box>
          )}
        </For>
      </Show>
      {/* Approvals: permission requests from headless agents, between the
          messages and the roster (they're answerable like messages but
          semantically closer to agent state). Exceptional traffic — when
          empty the whole section disappears, no heading, no bracket line. */}
      <Show when={approvals().length > 0}>
        <box flexDirection="column" marginBottom={1}>
          <SectionHeading label="approvals" />
          <For each={approvals()}>{(m) => <Row message={m} />}</For>
        </box>
      </Show>
      <SectionHeading label="agents" />
      <Show when={roster().length > 0} fallback={<EmptyLine label="[no agents online]" />}>
        <For each={roster()}>{(s) => <RosterRow session={s} />}</For>
      </Show>
    </box>
  )
}

/** Faint section heading ("messages" / "agents"), always visible. */
function SectionHeading(props: { label: string }) {
  return (
    <box paddingLeft={2} paddingRight={2}>
      <text wrapMode="none" truncate fg={FAINT}>
        {props.label}
      </text>
    </box>
  )
}

/** Faint empty-state line under a section heading. */
function EmptyLine(props: { label: string }) {
  return (
    <box paddingLeft={2} paddingRight={2} marginBottom={1}>
      <text wrapMode="none" truncate fg={FAINT}>
        {props.label}
      </text>
    </box>
  )
}
