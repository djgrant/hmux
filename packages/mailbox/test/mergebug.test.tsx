import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"
import { applyInit, drafts, state } from "../src/store"
import type { Message } from "@hmux/protocol"

const now = Date.now()
const messages: Message[] = [
  { id: "a1", kind: "ask", agent: "bot-a", body: "question A?", status: "pending", createdAt: now - 3 * 60_000 },
  { id: "a2", kind: "ask", agent: "bot-b", body: "question B?", status: "pending", createdAt: now - 2 * 60_000 },
  { id: "a3", kind: "ask", agent: "bot-c", body: "question C?", status: "pending", createdAt: now - 1 * 60_000 },
]

test("merge copies drafts (never consumes), ctrl+u re-copies, send cleans up", async () => {
  const sent: Array<[string, string]> = []
  applyInit(messages)
  const setup = await testRender(() => <App sendAnswer={(id, text) => (sent.push([id, text]), true)} />, { width: 100, height: 30 })
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 30))
      await setup.renderOnce()
    }
  }
  await settle()
  expect(state.currentId).toBe("a1")

  // Type a draft on a1, then merge a1+a2.
  setup.mockInput.typeText("asd")
  await settle()
  expect(drafts.get("a1")?.text).toBe("asd")
  setup.mockInput.pressArrow("left", { shift: true }) // queue, anchored on a1
  await settle()
  expect(state.highlightId).toBe("a1")
  setup.mockInput.pressArrow("down", { shift: true }) // select a1+a2
  await settle()
  setup.mockInput.pressEnter() // merge
  await settle()
  expect(state.merged).toEqual(["a1", "a2"])

  // The merged composer SEEDS from the member draft, but the member keeps
  // its own draft — backing out of an accidental merge loses nothing.
  expect(drafts.get("a1+a2")?.text).toBe("asd")
  expect(drafts.get("a1")?.text).toBe("asd") // preserved, not consumed
  let frame = setup.captureCharFrame()
  expect(frame).toContain("asd") // visible in the merged composer
  // Merged-only footer hint.
  expect(frame).toContain("ctrl+u update from drafts")

  // While merged, EVERY member row is highlighted (muted — composer owns
  // focus); the non-member row is not.
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
    const rows = frame.split("\n")
    const rowOf = (needle: string) => rows.findIndex((l) => l.slice(0, 30).includes(needle))
    expect(bgAt(1, rowOf("bot-a"))).toBe("38,38,38") // HIGHLIGHT_BG_MUTED #262626
    expect(bgAt(1, rowOf("bot-b"))).toBe("38,38,38")
    expect(bgAt(1, rowOf("bot-c"))).not.toBe("38,38,38")
  }

  // Diverge the merged draft, back out to the individual member: its
  // original draft is intact; edit it.
  setup.mockInput.typeText("X") // merged draft: "asdX"
  await settle()
  setup.mockInput.pressArrow("left", { shift: true }) // queue
  await settle()
  setup.mockInput.pressEnter() // commit a1 alone — leaves merged mode
  await settle()
  expect(state.merged).toEqual([])
  frame = setup.captureCharFrame()
  expect(frame).toContain("asd") // a1's own draft restored in the composer
  expect(frame).not.toContain("asdX")
  setup.mockInput.typeText("Q") // a1 draft: "asdQ"
  await settle()
  expect(drafts.get("a1")?.text).toBe("asdQ")

  // Re-merge: the existing merged draft persists and wins by default...
  setup.mockInput.pressArrow("left", { shift: true })
  await settle()
  setup.mockInput.pressArrow("down", { shift: true })
  await settle()
  setup.mockInput.pressEnter()
  await settle()
  expect(state.merged).toEqual(["a1", "a2"])
  expect(drafts.get("a1+a2")?.text).toBe("asdX")

  // ...and ctrl+u re-copies the members' CURRENT drafts on demand.
  setup.mockInput.pressKey("u", { ctrl: true })
  await settle()
  expect(drafts.get("a1+a2")).toEqual({ text: "asdQ", cursor: 4 })
  frame = setup.captureCharFrame()
  expect(frame).toContain("asdQ")

  // Send: the merged text goes to every member; only NOW are the member
  // drafts (and the merged draft) cleaned up.
  setup.mockInput.pressEnter()
  await settle()
  expect(sent).toEqual([["a1", "asdQ"], ["a2", "asdQ"]])
  // No meaningful draft content survives the send (a teardown clear event
  // may re-save an empty draft — same benign artifact the other flows have).
  expect(drafts.get("a1")?.text ?? "").toBe("")
  expect(drafts.get("a2")?.text ?? "").toBe("")
  expect(drafts.get("a1+a2")?.text ?? "").toBe("")
  expect(state.merged).toEqual([])
}, 20_000)
