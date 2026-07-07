import { For, Show, createEffect, onCleanup } from "solid-js"
import { useKeyboard, useRenderer, useSelectionHandler } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import {
  activeMessage,
  banner,
  commitHighlight,
  clearMerged,
  deleteDraft,
  extendSelection,
  bumpFocusEpoch,
  cycleCurrent,
  focusQueue,
  highlightedSession,
  incoming,
  markAnswered,
  mergedDraftFromMembers,
  mergedMessages,
  moveHighlight,
  showToast,
  state,
  stripControls,
  unread,
} from "./store"
import { AnsweredView, MessageView } from "./components/MessageView"
import { BANNER_BG, DIM, MAIN_BG } from "./theme"
import { Composer } from "./components/Composer"
import { Queue } from "./components/Queue"
import { Footer } from "./components/Footer"
import { createNotifier, formatNotification } from "./notify"

/**
 * Main-pane content cap: ≈960px at typical cell widths (~8–9px), so on very
 * wide terminals the message body and composer don't stretch edge to edge.
 */
const MAX_CONTENT_WIDTH = 112

/**
 * Top-right overlay: new-message banner / toast (wins) or the unread count.
 * top={1} aligns it with the message header line in the main pane.
 */
function TopRight() {
  return (
    <box position="absolute" top={1} right={2}>
      <Show
        when={banner()}
        keyed
        fallback={
          <Show when={unread() > 0}>
            <text fg={DIM}>{unread()} waiting</text>
          </Show>
        }
      >
        {(text) => (
          <box backgroundColor={BANNER_BG} paddingLeft={1} paddingRight={1}>
            <text wrapMode="none" truncate fg={DIM}>
              {text}
            </text>
          </box>
        )}
      </Show>
    </box>
  )
}

export function App(props: {
  sendAnswer: (id: string, text: string) => boolean
  /** Bind/unbind a session to the inbox; server confirms via session.updated. */
  sendBind?: (sessionId: string, bound: boolean) => boolean
  /** Writes selected text to the system clipboard. Injectable for tests. */
  copyText?: (text: string) => void
}) {
  const renderer = useRenderer()
  const defaultCopy = (text: string) => {
    // OSC 52 works over SSH and in most modern terminals; pbcopy is the local
    // macOS belt-and-braces fallback.
    try {
      renderer.copyToClipboardOSC52(text)
    } catch {}
    if (process.platform === "darwin") {
      try {
        const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" })
        proc.stdin.write(text)
        proc.stdin.end()
      } catch {}
    }
  }

  // Terminal tab title follows the displayed message (first line of the
  // highlighted/current message, truncated); neutral "humans" when empty.
  // setTerminalTitle is OpenTUI's sanctioned OSC-title API — but it emits
  // the payload into \x1b]0;…\x07 UNSANITIZED, and an embedded ESC aborts
  // the OSC mid-parse: the terminal then executes/prints the rest of the
  // title LITERALLY at the cursor (i.e. inside the composer). Ingress
  // sanitization already strips controls from bodies; stripControls here is
  // belt-and-braces for this escape-sequence egress specifically.
  createEffect(() => {
    const msg = activeMessage()
    const firstLine = stripControls(msg?.body.split("\n")[0] ?? "").trim()
    renderer.setTerminalTitle(firstLine.length > 0 ? firstLine.slice(0, 60) : "humans")
  })

  // System notification (OSC via triggerNotification, BEL fallback) on new
  // incoming messages, gated on terminal focus. Lives here — not in the ws
  // handler — because only the render tree has a renderer handle; the store's
  // `incoming` signal carries message.new across that boundary.
  const notifier = createNotifier({
    trigger: (message, title) => renderer.triggerNotification(message, title),
  })
  // On terminal focus, besides notification gating, bump the focus epoch so
  // the composer re-asserts textarea focus — resilience against renderable
  // focus having been stolen while away (see the scrollbox note below).
  const onTerminalFocus = () => {
    notifier.onFocus()
    bumpFocusEpoch()
  }
  renderer.on("focus", onTerminalFocus)
  renderer.on("blur", notifier.onBlur)
  onCleanup(() => {
    renderer.off("focus", onTerminalFocus)
    renderer.off("blur", notifier.onBlur)
  })
  createEffect(() => {
    const msg = incoming()
    if (msg) notifier.notify(formatNotification(msg.agent, msg.body))
  })

  // Select-to-copy: the renderer emits "selection" with isDragging=false when
  // a mouse selection completes (mouse-up); copy it and toast.
  useSelectionHandler((selection) => {
    if (selection.isDragging) return
    const text = selection.getSelectedText()
    if (!text) return
    ;(props.copyText ?? defaultCopy)(text)
    showToast("copied")
  })

  const answerOne = (id: string, text: string) => {
    if (!props.sendAnswer(id, text)) return false
    deleteDraft(id)
    markAnswered(id, text, Date.now())
    return true
  }

  // The displayed message's body scrollbox (single or merged view). Keyed
  // remounts overwrite the ref on every message switch; scrollBy on a
  // just-unmounted scrollbox is a harmless no-op.
  //
  // focusable=false is load-bearing: ScrollBoxRenderable is focusable by
  // default, and the renderer's click-to-focus walks up from the click target
  // to the nearest focusable — so a left click anywhere on the message body
  // (e.g. clicking back into the terminal) would FOCUS THE SCROLLBOX and blur
  // the composer textarea, leaving typing dead. Wheel scrolling and our
  // PgUp/PgDn handling don't need scrollbox focus.
  let messageScroll: ScrollBoxRenderable | undefined
  const setMessageScroll = (r: ScrollBoxRenderable) => {
    messageScroll = r
    r.focusable = false
  }

  useKeyboard((key) => {
    // PgUp/PgDn scroll the message body from ANY focus state: plain ↑↓ are
    // taken (textarea cursor / queue highlight) and the wheel already scrolls
    // by mouse position. preventDefault keeps the key out of the textarea.
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault()
      messageScroll?.scrollBy(key.name === "pagedown" ? 0.5 : -0.5, "viewport")
      return
    }
    if (state.focus === "queue") {
      // preventDefault is load-bearing for "return"/"shift+→": moving focus to
      // the composer flips state, which synchronously focuses the textarea.
      // That textarea registers its keypress handler on the same KeyHandler
      // that is mid-emit for THIS key event, so it would receive the very same
      // key and fire its "submit" binding (enter) or move the cursor (arrow).
      // Focused renderables check `key.defaultPrevented` before handling, so
      // marking the event consumed here guarantees it never reaches the
      // textarea.
      if (key.shift && (key.name === "up" || key.name === "down")) {
        // shift+↑↓ in the queue extends a contiguous selection.
        key.preventDefault()
        extendSelection(key.name === "down" ? 1 : -1)
      } else if (key.name === "up" || key.name === "down") {
        // Plain ↑↓ moves the highlight and collapses any selection.
        key.preventDefault()
        moveHighlight(key.name === "down" ? 1 : -1)
      } else if (highlightedSession() && (key.name === "return" || key.name === "b")) {
        // Roster row: ⏎ (or b) toggles bind. No optimistic flip — the
        // session.updated broadcast confirms it. Focus stays in the queue.
        key.preventDefault()
        const session = highlightedSession()!
        props.sendBind?.(session.id, !session.bound)
      } else if (key.name === "return" || (key.shift && key.name === "right")) {
        // The only queue→composer moves. Both commit (merged when a
        // multi-selection is active); the pane stays.
        key.preventDefault()
        commitHighlight()
      }
    } else {
      const msg = activeMessage()
      const composerFocused = msg && msg.status === "pending"
      if (!composerFocused) {
        // No focused textarea (empty state or answered view); pending
        // messages — asks AND notifies — always render a composer that owns
        // these keys itself. Same contract as the composer: shift+↑↓ cycles
        // the current message in place, shift+← is the way into the queue.
        if (key.shift && (key.name === "up" || key.name === "down")) {
          cycleCurrent(key.name === "down" ? 1 : -1)
        } else if (key.shift && key.name === "left") {
          focusQueue(0)
        }
      }
    }
  })

  const handleSend = (text: string) => {
    const msg = activeMessage()
    if (!msg) return
    answerOne(msg.id, text)
  }

  const handleMergedSend = (text: string) => {
    const targets = mergedMessages()
    for (const msg of targets) answerOne(msg.id, text)
    deleteDraft(targets.map((m) => m.id).join("+"))
    clearMerged()
  }

  const dimmed = () => state.focus === "queue"

  return (
    // Row at the root: both panes' paint reaches the actual terminal edges
    // (top/left/bottom); all padding lives inside the panes. The footer lives
    // inside the main column so the sidebar column owns its full height. The
    // root itself is painted too, so no terminal-default row can ever peek
    // through under the panes (belt-and-braces for odd resize timing).
    <box flexDirection="row" height="100%" backgroundColor={MAIN_BG}>
      <Queue />
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        alignSelf="stretch"
        backgroundColor={MAIN_BG}
        paddingTop={1}
        // Deliberately asymmetric: cell quantization makes the left gutter
        // read narrower than the right in some terminals, so it gets extra.
        paddingLeft={4}
        paddingRight={2}
      >
        {/* Width cap: message view + composer stay left-anchored and never
            stretch edge to edge on very wide terminals. The footer below is
            NOT capped; its hints are left-aligned so they sit with the
            content anyway. */}
        {/* minHeight=0 lets this column shrink so the squeeze from a long
            message lands on the body scrollbox, not on the composer/footer. */}
        <box flexGrow={1} minHeight={0} flexDirection="column" maxWidth={MAX_CONTENT_WIDTH}>
        <Show
          when={state.focus === "composer" && mergedMessages().length > 1}
          fallback={
            <Show
              when={activeMessage()}
              keyed
              // Single empty state: only the sidebar announces emptiness; the
              // main area stays blank (bg paint only).
              fallback={<box flexGrow={1} />}
            >
              {(msg) => (
                <>
                  <MessageView message={msg} dimmed={dimmed()} scrollRef={setMessageScroll} />
                  <Show
                    when={msg.status === "pending"}
                    fallback={
                      <AnsweredView
                        answer={msg.answer}
                        answeredAt={msg.answeredAt}
                        dimmed={dimmed()}
                      />
                    }
                  >
                    {/* Notifies get the same composer contract as asks: a
                        deliberate two-step (tab accepts the "dismiss" ghost,
                        ⏎ sends). Plain ⏎ on the empty composer does nothing,
                        so a stray Enter can never dismiss an FYI. */}
                    <Show when={msg.kind === "notify"}>
                      <box flexShrink={0}>
                        <text fg={DIM}>fyi — tab then ⏎ to dismiss</text>
                      </box>
                    </Show>
                    {/* Approvals: tab+⏎ accepts the "allow" ghost; any typed
                        text becomes the denial reason the agent sees. */}
                    <Show when={msg.kind === "approval"}>
                      <box flexShrink={0}>
                        <text fg={DIM}>approval — tab then ⏎ to allow · type a reason to deny</text>
                      </box>
                    </Show>
                    <Composer
                      messageId={msg.id}
                      focused={state.focus === "composer"}
                      suggestion={
                        msg.kind === "notify"
                          ? (msg.suggestion ?? "dismiss")
                          : msg.kind === "approval"
                            ? (msg.suggestion ?? "allow")
                            : msg.suggestion
                      }
                      onSend={handleSend}
                    />
                  </Show>
                </>
              )}
            </Show>
          }
        >
          {/* Merged mode: the selected messages stacked, one composer, one
              answer delivered to every id. The whole stack scrolls as one so
              it can never overflow into the pinned composer. */}
          <scrollbox
            ref={setMessageScroll}
            flexGrow={1}
            minHeight={0}
            contentOptions={{ flexDirection: "column", gap: 1 }}
          >
            <For each={mergedMessages()}>
              {(msg) => <MessageView message={msg} dimmed={dimmed()} grow={false} />}
            </For>
          </scrollbox>
          <Composer
            messageId={mergedMessages().map((m) => m.id).join("+")}
            focused={state.focus === "composer"}
            // Batch approvals (selections never mix kinds): the ghost is
            // "allow" so tab+⏎ approves every selected request at once.
            suggestion={
              mergedMessages().every((m) => m.kind === "approval") ? "allow" : undefined
            }
            // ctrl+u: re-copy the members' current drafts (merging copies,
            // never consumes them).
            regenerate={mergedDraftFromMembers}
            onSend={handleMergedSend}
          />
        </Show>
        </box>
        <Footer />
      </box>
      <TopRight />
    </box>
  )
}
