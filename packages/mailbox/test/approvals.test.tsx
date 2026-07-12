import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"
import { applyInit, approvals, pending, selectedIds, state } from "../src/store"
import type { Message, Session } from "@hmux/protocol"

const now = Date.now()
const messages: Message[] = [
  { id: "a1", kind: "ask", agent: "bot-a", project: "p", body: "Ship?", status: "pending", createdAt: now - 120_000 },
  { id: "ap1", kind: "approval", agent: "headless-1", project: "p", body: "wants to run Bash\n\n```json\n{\n  \"command\": \"rm -rf dist\"\n}\n```", suggestion: "allow", status: "pending", createdAt: now - 60_000 },
  { id: "ap2", kind: "approval", agent: "headless-2", project: "p", body: "wants to run Edit\n\n```json\n{\n  \"file_path\": \"a.ts\"\n}\n```", suggestion: "allow", status: "pending", createdAt: now - 30_000 },
]

const sessions: Session[] = [
  {
    id: "s1",
    agent: "bot-a",
    project: "p",
    status: "needs-attention",
    detail: "Claude needs your permission to use Bash",
    bound: false,
    startedAt: now - 10 * 60_000,
    lastSeen: now,
  },
]

test("approvals section, kind-safe selection, batch allow, blocked label", async () => {
  const sent: Array<[string, string]> = []
  applyInit(messages, sessions)
  const setup = await testRender(
    () => <App sendAnswer={(id, text) => (sent.push([id, text]), true)} />,
    { width: 160, height: 34 },
  )
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 30))
      await setup.renderOnce()
    }
  }
  await settle()
  let frame = setup.captureCharFrame()

  // Sidebar order: messages → approvals → agents; approval rows show the
  // agent + tool summary snippet.
  const lines = frame.split("\n")
  const sidebar = (needle: string) => lines.findIndex((l) => l.slice(0, 48).includes(needle))
  expect(approvals().map((m) => m.id)).toEqual(["ap1", "ap2"])
  expect(sidebar("approvals")).toBeGreaterThan(sidebar("messages"))
  expect(sidebar("agents")).toBeGreaterThan(sidebar("approvals"))
  expect(frame).toContain("headless-1")
  expect(frame).toContain("wants to run Bash…")
  // Roster: needs-attention reads "blocked" with the reason underneath.
  expect(frame).toContain("bot-a  blocked")
  expect(frame).toContain("Claude needs your permission to use Bash")

  // Nav order: pending = [a1 (messages), ap1, ap2 (approvals)].
  expect(pending().map((m) => m.id)).toEqual(["a1", "ap1", "ap2"])

  // A selection must not cross the messages/approvals boundary.
  setup.mockInput.pressArrow("left", { shift: true }) // queue, anchored a1
  await settle()
  expect(state.highlightId).toBe("a1")
  setup.mockInput.pressArrow("down", { shift: true }) // blocked: ap1 is an approval
  await settle()
  expect(state.highlightId).toBe("a1")
  expect(selectedIds()).toEqual(["a1"])

  // Batch allow: select both approvals, merge, accept the "allow" ghost.
  setup.mockInput.pressArrow("down") // ap1 (plain move crosses fine)
  await settle()
  expect(state.highlightId).toBe("ap1")
  setup.mockInput.pressArrow("down", { shift: true }) // extend: ap1+ap2
  await settle()
  expect(selectedIds()).toEqual(["ap1", "ap2"])
  setup.mockInput.pressEnter() // merged mode
  await settle()
  frame = setup.captureCharFrame()
  expect(state.merged).toEqual(["ap1", "ap2"])
  expect(frame).toContain(" allow") // merged ghost is "allow", not "ok"
  setup.mockInput.pressTab() // accept ghost
  setup.mockInput.pressEnter()
  await settle()
  expect(sent).toEqual([
    ["ap1", "allow"],
    ["ap2", "allow"],
  ])

  // Single approval flow: the hint + "allow" ghost, typed text = deny reason.
  expect(state.currentId).toBe("a1") // only a1 left pending
  applyInit(
    [
      messages[0]!,
      { ...messages[1]!, id: "ap3", agent: "headless-3", status: "pending" },
    ],
    sessions,
  )
  await settle()
  setup.mockInput.pressArrow("down", { shift: true }) // cycle in place: a1 → ap3
  await settle()
  expect(state.currentId).toBe("ap3")
  frame = setup.captureCharFrame()
  expect(frame).toContain("approval — tab then ⏎ to allow · type a reason to deny")
  setup.mockInput.typeText("not now")
  setup.mockInput.pressEnter()
  await settle()
  expect(sent.at(-1)).toEqual(["ap3", "not now"])

  // Suite hygiene: leave the store composer-focused and empty.
  applyInit([], [])
  await settle()
  expect(state.focus).toBe("composer")
}, 20_000)
