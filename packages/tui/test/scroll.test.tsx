import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"
import { applyInit } from "../src/store"
import type { Message } from "@humans/protocol"

// A body far taller than the 30-row viewport: numbered lines so we can tell
// exactly which slice of the message is visible.
const longBody = Array.from({ length: 120 }, (_, i) => `line ${i + 1} of the novel`).join("\n\n")

const messages: Message[] = [
  {
    id: "long1",
    kind: "ask",
    agent: "novelist-bot",
    project: "humans.sh",
    body: longBody,
    suggestion: "looks good",
    status: "pending",
    createdAt: Date.now() - 60_000,
  },
]

test("long message scrolls; composer stays pinned and un-crushed", async () => {
  applyInit(messages)
  const setup = await testRender(
    () => <App sendAnswer={() => true} />,
    { width: 110, height: 30 },
  )
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 30))
      await setup.renderOnce()
    }
  }
  await settle()
  let frame = setup.captureCharFrame()

  // Top of the message is visible; the tail is clipped by the scrollbox.
  expect(frame).toContain("line 1 of the novel")
  expect(frame).not.toContain("line 120 of the novel")

  // The composer is pinned and intact: full border box + ghost, and the
  // footer below it — nothing overlapped or crushed to zero height.
  const rows = frame.split("\n")
  const ghostRow = rows.findIndex((l) => l.includes("looks good"))
  expect(ghostRow).toBeGreaterThan(0)
  expect(rows[ghostRow - 1]!).toContain("┌") // border top above the ghost
  expect(rows[ghostRow + 1]!).toContain("└") // border bottom below it
  expect(rows[ghostRow + 2]!).toContain("1/1") // footer under the composer

  // PgDn scrolls the body down half a viewport; PgUp comes back. (Raw CSI
  // sequences: mock-keys has no named page keys.)
  setup.mockInput.pressKey("\x1b[6~") // pagedown
  await settle()
  frame = setup.captureCharFrame()
  expect(frame).not.toContain("line 1 of the novel")
  expect(frame).toContain("looks good") // composer untouched
  setup.mockInput.pressKey("\x1b[5~") // pageup
  await settle()
  frame = setup.captureCharFrame()
  expect(frame).toContain("line 1 of the novel")
})
