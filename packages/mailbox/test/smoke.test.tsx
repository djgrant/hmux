import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"
import {
  addMessage,
  announceIncoming,
  applyInit,
  drafts,
  markAnswered,
  selectedIds,
  showBanner,
  state,
  unread,
} from "../src/store"
import type { Message } from "@hmux/protocol"

const now = Date.now()
const messages: Message[] = [
  { id: "m1", kind: "ask", agent: "refactor-bot", project: "hmux", body: "Rename `Queue` to **Inbox**?", status: "pending", createdAt: now - 2 * 60_000 },
  { id: "m2", kind: "ask", agent: "deploy-bot", project: "hmux", body: "Ship now?", context: "CI is green.", suggestion: "yes, ship it", status: "pending", createdAt: now - 60 * 60_000 },
  { id: "m3", kind: "ask", agent: "scraper", body: "Back off 1h?", status: "pending", createdAt: now - 5 * 60_000 },
  { id: "m4", kind: "ask", agent: "docs-bot", project: "hmux", body: "Bold headings?", status: "answered", answer: "Yes.", createdAt: now - 3 * 3_600_000, answeredAt: now - 2 * 3_600_000 },
  { id: "m6", kind: "notify", agent: "ci-bot", body: "build passed on main", status: "pending", createdAt: now - 60_000 },
]

// Explicit timeout: the settle() cadence puts this long scenario just over
// bun's 5s default.
test("merge-select, notify dismiss, pruned focus keys, hints", async () => {
  const sent: Array<[string, string]> = []
  const copied: string[] = []
  applyInit(messages)
  const setup = await testRender(
    () => (
      <App
        sendAnswer={(id, text) => (sent.push([id, text]), true)}
        copyText={(text) => copied.push(text)}
        // Pin the OSC gate open: the default probes the machine's real tmux
        // for control-mode clients, which would suppress the notifications
        // this test asserts on (and vary by dev environment).
        oscNotificationsSafe={true}
      />
    ),
    { width: 110, height: 34 },
  )
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 30))
      await setup.renderOnce()
    }
  }
  await settle()
  let frame = setup.captureCharFrame()

  // Initial: composer focused on oldest pending; hints teach queue entry.
  // pending order: hmux [m2, m1], (no project) [m3, m6-notify]
  expect(state.focus).toBe("composer")
  expect(state.currentId).toBe("m2")
  expect(unread()).toBe(3)
  expect(frame).toContain("yes, ship it") // ghost
  // Footer: counter FIRST, then hints; no "queue" copy, no ⌘ mention.
  expect(frame).toContain("1/4 · ")
  expect(frame).toContain("shift+↑↓")
  expect(frame).not.toContain("⌘")
  expect(frame).not.toContain("queue")
  const footerRow = frame.split("\n").find((l) => l.includes("1/4"))!
  // Left-aligned: the footer starts at the main pane's left edge (sidebar
  // width 33 + paddingLeft 4 = col 37), nowhere near the right edge.
  expect(footerRow.search(/\S/)).toBe(37)
  expect(footerRow.trimEnd().endsWith("shift+↑↓")).toBe(true) // counter leads

  // Ghost accept + send still work.
  setup.mockInput.pressTab()
  await settle()
  expect(drafts.get("m2")).toEqual({ text: "yes, ship it", cursor: 12 })
  setup.mockInput.pressEnter()
  await settle()
  expect(sent).toEqual([["m2", "yes, ship it"]])
  // Group order re-anchors once m2 is answered: pending is now [m3, m6, m1].
  expect(state.currentId).toBe("m3")

  // shift+↓ from composer: switch the current message IN PLACE — focus
  // stays on the composer, the sidebar highlight follows.
  setup.mockInput.pressArrow("down", { shift: true })
  await settle()
  expect(state.focus).toBe("composer")
  expect(state.currentId).toBe("m6")
  expect(state.highlightId).toBe("m6")

  // shift+← is the deliberate way into the queue (anchored, no move).
  setup.mockInput.pressArrow("left", { shift: true })
  await settle()
  expect(state.focus).toBe("queue")
  expect(state.highlightId).toBe("m6")
  frame = setup.captureCharFrame()
  expect(frame).toContain("↑↓ move · shift+↑↓ select · ⏎ answer")

  // Highlight paint runs flush: col 0 and the sidebar's last col share the
  // highlight bg on the highlighted row.
  {
    const lines = setup.renderer.currentRenderBuffer.getSpanLines()
    const bgAt = (x: number, y: number) => {
      let col = 0
      for (const s of lines[y]!.spans) {
        if (x < col + s.width) return [s.bg.r, s.bg.g, s.bg.b].map((v) => Math.round(v * 255)).join(",")
        col += s.width
      }
      return "?"
    }
    const sidebarWidth = Math.min(48, Math.max(30, Math.round(110 * 0.3)))
    const rowIdx = frame.split("\n").findIndex((l) => l.slice(0, sidebarWidth).includes("ci-bot"))
    expect(bgAt(0, rowIdx)).toBe("58,58,58") // HIGHLIGHT_BG #3a3a3a
    expect(bgAt(sidebarWidth - 1, rowIdx)).toBe("58,58,58")
  }

  // Plain ↑↓ move without selecting; shift+↑↓ in the queue EXTENDS.
  setup.mockInput.pressArrow("down")
  await settle()
  expect(state.highlightId).toBe("m1")
  expect(selectedIds()).toEqual([])
  setup.mockInput.pressArrow("up")
  await settle()
  setup.mockInput.pressArrow("up")
  await settle()
  expect(state.highlightId).toBe("m3")
  setup.mockInput.pressArrow("down", { shift: true })
  await settle()
  expect(selectedIds()).toEqual(["m3", "m6"])

  // Plain → no longer commits; esc no longer blurs.
  setup.mockInput.pressArrow("right")
  setup.mockInput.pressEscape()
  await settle()
  expect(state.focus).toBe("queue")
  expect(selectedIds()).toEqual(["m3", "m6"])

  // Enter with a multi-selection: merged mode, both bodies stacked.
  setup.mockInput.pressEnter()
  await settle()
  frame = setup.captureCharFrame()
  expect(state.focus).toBe("composer")
  expect(state.merged).toEqual(["m3", "m6"])
  expect(frame).toContain("Back off 1h?")
  expect(frame).toContain("build passed on main")
  expect(frame).toContain(" ok") // merged ghost defaults to "ok"

  // One answer text delivered to every selected id; then advance as usual.
  setup.mockInput.typeText("on it")
  setup.mockInput.pressEnter()
  await settle()
  expect(sent.slice(1)).toEqual([
    ["m3", "on it"],
    ["m6", "on it"],
  ])
  expect(state.merged).toEqual([])
  expect(state.currentId).toBe("m1")

  // Notify messages: same two-step contract as asks — composer with a
  // "dismiss" ghost; plain ⏎ on the empty composer does NOTHING.
  const m7: Message = { id: "m7", kind: "notify", agent: "watchdog", body: "disk at 80%", status: "pending", createdAt: Date.now() }
  addMessage(m7)
  await settle()
  expect(unread()).toBe(1) // notifies still count
  setup.mockInput.pressArrow("down", { shift: true }) // cycle in place: m1 -> m7
  await settle()
  frame = setup.captureCharFrame()
  expect(state.focus).toBe("composer") // never left the composer
  expect(state.currentId).toBe("m7")
  expect(state.highlightId).toBe("m7")
  expect(frame).toContain("fyi — tab then ⏎ to dismiss")
  const sentBefore = sent.length
  setup.mockInput.pressEnter() // empty composer: must NOT dismiss
  await settle()
  expect(sent.length).toBe(sentBefore)
  expect(state.currentId).toBe("m7") // still pending, still current
  setup.mockInput.pressTab() // accept the "dismiss" ghost
  setup.mockInput.pressEnter()
  await settle()
  expect(sent.at(-1)).toEqual(["m7", "dismiss"])
  expect(state.currentId).toBe("m1")

  // shift+← from the composer: focus the queue WITHOUT moving the highlight.
  setup.mockInput.pressArrow("left", { shift: true })
  await settle()
  expect(state.focus).toBe("queue")
  expect(state.highlightId).toBe("m1") // anchored on current, not moved
  setup.mockInput.pressArrow("right", { shift: true }) // back to composer
  await settle()
  expect(state.focus).toBe("composer")

  // shift+↓ with a single pending message: wraps to itself, composer keeps
  // focus and the key never reaches the textarea.
  setup.mockInput.pressArrow("down", { shift: true })
  await settle()
  expect(state.focus).toBe("composer")
  expect(state.currentId).toBe("m1")
  expect(drafts.get("m1")?.text ?? "").toBe("")

  // shift+→ commits from the queue exactly like enter.
  setup.mockInput.pressArrow("left", { shift: true }) // into the queue
  await settle()
  expect(state.focus).toBe("queue")
  setup.mockInput.pressArrow("right", { shift: true })
  await settle()
  expect(state.focus).toBe("composer")
  expect(state.currentId).toBe("m1")
  expect(drafts.get("m1")?.text ?? "").toBe("") // key never reached textarea

  // cmd(super)+arrows do NOTHING: shift is the whole navigation surface.
  setup.mockInput.pressArrow("down", { super: true })
  await settle()
  expect(state.focus).toBe("composer") // super+↓ no longer enters the queue
  expect(state.currentId).toBe("m1")
  expect(drafts.get("m1")?.text ?? "").toBe("") // and never reaches the textarea

  // Select-to-copy still works, with toast.
  await setup.mockMouse.drag(40, 1, 70, 1)
  await settle()
  frame = setup.captureCharFrame()
  expect(copied.length).toBe(1)
  expect(frame).toContain("copied")

  // Banner on message.new.
  const m8: Message = { id: "m8", kind: "ask", agent: "new-bot", body: "hello there, quick question about the deploy pipeline", status: "pending", createdAt: Date.now() }
  addMessage(m8)
  showBanner(m8)
  await settle()
  frame = setup.captureCharFrame()
  expect(frame).toContain("new-bot: hello there")

  // System notification on message.new (announceIncoming = ws wiring): the
  // App effect calls renderer.triggerNotification, gated on terminal focus.
  const notified: Array<[string, string | undefined]> = []
  ;(setup.renderer as any).triggerNotification = (m: string, t?: string) => (
    notified.push([m, t]), true
  )
  const m9: Message = { id: "m9", kind: "ask", agent: "ping-bot", body: "line one\nline two", status: "pending", createdAt: Date.now() }
  addMessage(m9)
  announceIncoming(m9)
  await settle()
  // Focus state unknown at this point → notify.
  expect(notified).toEqual([["ping-bot: line one", "hmux"]])
  // Terminal reports focus → suppressed.
  setup.renderer.emit("focus")
  const m10: Message = { id: "m10", kind: "ask", agent: "ping-bot", body: "again", status: "pending", createdAt: Date.now() }
  addMessage(m10)
  announceIncoming(m10)
  await settle()
  expect(notified.length).toBe(1)
  // Blur → notifications resume.
  setup.renderer.emit("blur")
  const m11: Message = { id: "m11", kind: "ask", agent: "ping-bot", body: "third", status: "pending", createdAt: Date.now() }
  addMessage(m11)
  announceIncoming(m11)
  await settle()
  expect(notified.at(-1)).toEqual(["ping-bot: third", "hmux"])
  markAnswered("m9", "ok", Date.now())
  markAnswered("m10", "ok", Date.now())
  markAnswered("m11", "ok", Date.now())

  // Empty queue note + empty state.
  markAnswered("m1", "ok", Date.now())
  markAnswered("m8", "later", Date.now())
  await settle()
  frame = setup.captureCharFrame()
  // Empty queue: both headings stay, each with its faint bracket line.
  expect(frame).toContain("messages")
  expect(frame).toContain("[no new messages]")
  expect(frame).toContain("agents")
  expect(frame).toContain("[no agents online]")
}, 20_000)
