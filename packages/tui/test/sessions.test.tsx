import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"
import {
  SESSION_STALE_MS,
  applyInit,
  presenceOf,
  roster,
  sessionFor,
  sessionStale,
  state,
  upsertSession,
} from "../src/store"
import type { Message, Session } from "@humans/protocol"

const now = Date.now()

function makeSession(overrides: Partial<Session> & { id: string; agent: string }): Session {
  return {
    project: undefined,
    status: "working",
    bound: false,
    startedAt: now - 10 * 60_000,
    lastSeen: now,
    ...overrides,
  }
}

const messages: Message[] = [
  // Group order: humans.sh (m2 oldest) then (no project); pending = [m2, m1, m3].
  { id: "m2", kind: "ask", agent: "deploy-bot", project: "humans.sh", body: "Ship now?", status: "pending", createdAt: now - 3_600_000 },
  { id: "m1", kind: "ask", agent: "refactor-bot", project: "humans.sh", body: "Rename Queue?", status: "pending", createdAt: now - 120_000 },
  { id: "m3", kind: "ask", agent: "scraper", body: "Back off 1h?", status: "pending", createdAt: now - 300_000 },
]

// Roster order is startedAt-asc: s2 (deploy-bot, idle, bound) then s1
// (refactor-bot, working). s4 (scraper) is ended → excluded, and its pending
// ask m3 becomes a zombie.
const sessions: Session[] = [
  makeSession({ id: "s1", agent: "refactor-bot", project: "humans.sh", status: "working" }),
  makeSession({ id: "s2", agent: "deploy-bot", project: "humans.sh", status: "idle", bound: true, startedAt: now - 90 * 60_000, lastSeen: now - 20_000 }),
  makeSession({ id: "s4", agent: "scraper", status: "idle", startedAt: now - 3 * 3_600_000, lastSeen: now - 30 * 60_000, endedAt: now - 25 * 60_000 }),
]

test("session staleness, upsert, and conservative presence matching", () => {
  applyInit(messages, [])
  expect(state.sessions).toEqual([])

  // Staleness: fresh is live; silent past the threshold or ended is dead.
  const fresh = makeSession({ id: "s9", agent: "a", lastSeen: now })
  expect(sessionStale(fresh, now)).toBe(false)
  expect(sessionStale(fresh, now + SESSION_STALE_MS + 1)).toBe(true)
  expect(sessionStale({ ...fresh, endedAt: now }, now)).toBe(true)

  // Upsert: insert then whole-object replace (stale fields must not survive).
  upsertSession(makeSession({ id: "s1", agent: "refactor-bot", project: "humans.sh", status: "working", endedAt: now }))
  expect(state.sessions.length).toBe(1)
  upsertSession(makeSession({ id: "s1", agent: "refactor-bot", project: "humans.sh", status: "idle" }))
  expect(state.sessions.length).toBe(1)
  expect(state.sessions[0]!.status).toBe("idle")
  expect(state.sessions[0]!.endedAt).toBeUndefined() // replaced, not merged

  // Presence matches on agent AND project; a name match alone is not enough.
  expect(presenceOf(messages[1]!)).toBe("live") // refactor-bot @ humans.sh, idle
  expect(sessionFor({ ...messages[1]!, project: "other" })).toBeUndefined()
  expect(presenceOf({ ...messages[1]!, project: undefined })).toBe("none")
  expect(presenceOf(messages[0]!)).toBe("none") // deploy-bot: no session yet

  upsertSession(makeSession({ id: "s3", agent: "deploy-bot", project: "humans.sh", status: "needs-attention" }))
  expect(presenceOf(messages[0]!)).toBe("attention")
  upsertSession(makeSession({ id: "s4", agent: "scraper", endedAt: now }))
  expect(presenceOf(messages[2]!)).toBe("dead") // both projects undefined match

  // Roster: live sessions only, startedAt order; ended/stale excluded.
  // (Wide margin past the threshold: the store's now() ticks at 15s grain.)
  upsertSession(makeSession({ id: "s5", agent: "old-bot", lastSeen: now - SESSION_STALE_MS - 60_000 }))
  expect(roster().map((s) => s.id)).toEqual(["s1", "s3"])
})

test("roster rendering, navigation past messages, bind toggle", async () => {
  const bound: Array<[string, boolean]> = []
  applyInit(messages, sessions)
  // width 160 → sidebar at its 48-col cap, so roster rows don't truncate.
  const setup = await testRender(
    () => <App sendAnswer={() => true} sendBind={(id, b) => (bound.push([id, b]), true)} />,
    { width: 160, height: 34 },
  )
  const sidebarWidth = 48
  // The main pane header also prints agent names; count in the sidebar only.
  const inSidebar = (frame: string, needle: string) =>
    frame.split("\n").filter((l) => l.slice(0, sidebarWidth).includes(needle)).length
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 30))
      await setup.renderOnce()
    }
  }
  await settle()
  let frame = setup.captureCharFrame()

  // Roster section: header + one row per live session, ended excluded.
  expect(frame).toContain("agents")
  expect(frame).toContain("⁘ bound") // s2 arrives bound
  expect(frame).toContain("idle") // s2 idle-age via formatAge
  expect(frame).toContain("● refactor-bot") // presence dot on the message row too
  expect(frame).toContain("○ scraper") // zombie ask: faint hollow marker
  // scraper's session is ended: it appears as a message row only, not roster.
  expect(inSidebar(frame, "scraper")).toBe(1)
  expect(inSidebar(frame, "deploy-bot")).toBe(2) // message row + roster row

  // Navigate: shift+← into the queue (anchored on the current message),
  // then ↓ past the last message into the roster.
  expect(state.currentId).toBe("m2")
  setup.mockInput.pressArrow("left", { shift: true }) // queue, anchored m2
  setup.mockInput.pressArrow("down") // m1
  setup.mockInput.pressArrow("down") // m3
  setup.mockInput.pressArrow("down") // roster: s2
  await settle()
  expect(state.focus).toBe("queue")
  expect(state.highlightId).toBe("s2")
  frame = setup.captureCharFrame()
  expect(frame).toContain("⏎ bind/unbind") // roster footer hint

  // ⏎ on a bound session: emit unbind; no optimistic flip (server confirms).
  setup.mockInput.pressEnter()
  await settle()
  expect(bound).toEqual([["s2", false]])
  expect(state.focus).toBe("queue") // never commits to the composer
  upsertSession({ ...sessions[1]!, bound: false }) // session.updated confirm
  await settle()
  frame = setup.captureCharFrame()
  expect(frame).not.toContain("⁘ bound")

  // shift+↓ on a roster row just moves (no selection); 'b' also toggles.
  setup.mockInput.pressArrow("down", { shift: true }) // s2 → s1
  await settle()
  expect(state.highlightId).toBe("s1")
  setup.mockInput.typeText("b")
  await settle()
  expect(bound).toEqual([["s2", false], ["s1", true]])
  upsertSession({ ...sessions[0]!, bound: true })
  await settle()
  frame = setup.captureCharFrame()
  expect(frame).toContain("⁘ bound")

  // shift+→ on a roster row must not commit; ↓ wraps back to the messages.
  setup.mockInput.pressArrow("right", { shift: true })
  await settle()
  expect(state.focus).toBe("queue")
  setup.mockInput.pressArrow("down") // wrap: s1 → m2
  await settle()
  expect(state.highlightId).toBe("m2")

  // Leave focus on the composer for suite hygiene (shared store module).
  setup.mockInput.pressEnter()
  await settle()
  expect(state.focus).toBe("composer")

  // Empty roster: section disappears entirely — no header, no copy.
  applyInit(messages, [])
  await settle()
  frame = setup.captureCharFrame()
  expect(frame).not.toContain("agents")
  expect(frame).not.toContain("⁘")
}, 20_000)
