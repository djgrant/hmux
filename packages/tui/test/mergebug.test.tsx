import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"
import { applyInit, drafts, state } from "../src/store"
import type { Message } from "@humans/protocol"

const now = Date.now()
const messages: Message[] = [
  { id: "a1", kind: "ask", agent: "bot-a", body: "question A?", status: "pending", createdAt: now - 3 * 60_000 },
  { id: "a2", kind: "ask", agent: "bot-b", body: "question B?", status: "pending", createdAt: now - 2 * 60_000 },
  { id: "a3", kind: "ask", agent: "bot-c", body: "question C?", status: "pending", createdAt: now - 1 * 60_000 },
]

test("merge inherits and consumes member drafts", async () => {
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
  expect(state.focus).toBe("queue")
  expect(state.highlightId).toBe("a1")
  setup.mockInput.pressArrow("down", { shift: true }) // select a1+a2
  await settle()
  setup.mockInput.pressEnter() // merge
  await settle()
  expect(state.merged).toEqual(["a1", "a2"])

  // THE BUG: a1's individual draft must be consumed into the merged composer.
  expect(drafts.get("a1")).toBeUndefined()
  expect(drafts.get("a1+a2")?.text).toBe("asd")
  const frame = setup.captureCharFrame()
  expect(frame).toContain("asd") // visible in the merged composer

  // Send: the merged composer's text goes to every id — nothing stale.
  setup.mockInput.pressEnter()
  await settle()
  expect(sent).toEqual([["a1", "asd"], ["a2", "asd"]])
})
