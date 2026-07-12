import { Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { Message } from "@hmux/protocol"
import { formatAge, NO_PROJECT } from "../store"
import { DIM, FAINT, markdownSyntax, markdownSyntaxDim } from "../theme"

/** Read-only view shown in place of the composer for answered messages. */
export function AnsweredView(props: { answer?: string; answeredAt?: number; dimmed?: boolean }) {
  return (
    <box flexDirection="column" paddingBottom={1} flexShrink={0}>
      <text fg={props.dimmed ? FAINT : DIM}>
        answered{props.answeredAt !== undefined ? ` · ${formatAge(props.answeredAt)} ago` : ""}
      </text>
      <Show when={props.answer} keyed>
        {(answer) => (
          <markdown
            content={answer}
            syntaxStyle={props.dimmed ? markdownSyntaxDim() : markdownSyntax()}
          />
        )}
      </Show>
    </box>
  )
}

/** Body + optional context, shared by the scrolling and stacked variants. */
function Body(props: { message: Message; dimmed?: boolean }) {
  const syntax = () => (props.dimmed ? markdownSyntaxDim() : markdownSyntax())
  return (
    <>
      <markdown content={props.message.body} syntaxStyle={syntax()} />
      <Show when={props.message.context} keyed>
        {(context) => <markdown content={context} syntaxStyle={syntax()} />}
      </Show>
    </>
  )
}

/**
 * dimmed: attenuate the whole view (used while the queue has focus).
 * grow: fill remaining height (off when stacked in merged mode; the merged
 *   stack scrolls as a whole in App.tsx instead).
 * scrollRef: receives the body scrollbox so App can drive PgUp/PgDn.
 *
 * In grow mode the body lives in a scrollbox so a long message scrolls
 * (PgUp/PgDn, mouse wheel) instead of overflowing into the composer, which
 * stays pinned below. minHeight=0 is load-bearing: without it flex children
 * refuse to shrink below their content height and the overflow comes back.
 */
export function MessageView(props: {
  message: Message
  dimmed?: boolean
  grow?: boolean
  scrollRef?: (r: ScrollBoxRenderable) => void
}) {
  const header = () => (
    <text fg={props.dimmed ? FAINT : DIM}>
      {props.message.agent} · {props.message.project ?? NO_PROJECT} ·{" "}
      {formatAge(props.message.createdAt)}
    </text>
  )
  return (
    <Show
      when={props.grow !== false}
      fallback={
        <box flexDirection="column" gap={1}>
          {header()}
          <box flexDirection="column" gap={1}>
            <Body message={props.message} dimmed={props.dimmed} />
          </box>
        </box>
      }
    >
      <box flexGrow={1} minHeight={0} flexDirection="column" gap={1}>
        {header()}
        <scrollbox
          // focusable=false even without a scrollRef consumer: a click on the
          // body must never steal renderable focus from the composer (see the
          // setMessageScroll note in App.tsx).
          ref={(r: ScrollBoxRenderable) => {
            r.focusable = false
            props.scrollRef?.(r)
          }}
          flexGrow={1}
          minHeight={0}
          contentOptions={{ flexDirection: "column", gap: 1 }}
        >
          <Body message={props.message} dimmed={props.dimmed} />
        </scrollbox>
      </box>
    </Show>
  )
}
