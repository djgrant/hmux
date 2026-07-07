import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"
import { applyInit, state } from "../src/store"
import type { Message, Session } from "@humans/protocol"

const now = Date.now()

// Round 20 root cause: when the sidebar's content exceeded the pane height,
// yoga shrank rows to ZERO height and stacked several rows' text on the same
// terminal line — message text smeared over the TUI, evolving with every
// diff. Rows are now flexShrink=0 and the sidebar clips (overflow=hidden):
// overflowing rows disappear off the bottom instead of blending.
test("sidebar overflow clips rows instead of stacking them", async () => {
  const messages: Message[] = Array.from({ length: 18 }, (_, i) => ({
    id: `o${i}`,
    kind: "ask" as const,
    agent: `bot-${String(i).padStart(2, "0")}`,
    project: "p",
    body: `question ${i}?`,
    status: "pending" as const,
    createdAt: now - (18 - i) * 60_000,
  }))
  const sessions: Session[] = Array.from({ length: 4 }, (_, i) => ({
    id: `s${i}`,
    agent: `agent-${i}`,
    project: "p",
    status: "needs-attention" as const,
    detail: `needs permission for thing ${i}`,
    bound: false,
    startedAt: now - 10 * 60_000,
    lastSeen: now,
  }))
  applyInit(messages, sessions)
  // 12 rows tall: headings + 18 message rows + roster (2 lines each) cannot fit.
  const setup = await testRender(() => <App sendAnswer={() => true} />, { width: 120, height: 12 })
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 30))
      await setup.renderOnce()
    }
  }
  await settle()
  const frame = setup.captureCharFrame()
  const lines = frame.split("\n")
  expect(lines.length).toBeLessThanOrEqual(13)

  // No line blends two rows: every sidebar line contains at most ONE agent
  // name, and any shown agent appears exactly once in the whole sidebar.
  const agentNames = messages.map((m) => m.agent).concat(sessions.map((s) => s.agent))
  for (const line of lines) {
    const sidebar = line.slice(0, 36)
    const found = agentNames.filter((a) => sidebar.includes(a))
    expect(found.length).toBeLessThanOrEqual(1)
  }
  for (const a of agentNames) {
    const count = lines.filter((l) => l.slice(0, 36).includes(a)).length
    expect(count).toBeLessThanOrEqual(1)
  }

  // The rows that fit are intact (heading + first rows), the rest clipped.
  expect(frame).toContain("messages")
  expect(frame).toContain("bot-00")
  expect(frame).not.toContain("bot-17") // clipped off the bottom, not blended

  // Suite hygiene.
  applyInit([], [])
  await settle()
  expect(state.focus).toBe("composer")
}, 20_000)
