import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"
import { addMessage, applyInit, state, stripControls, upsertSession } from "../src/store"
import type { Message, Session } from "@humans/protocol"

const now = Date.now()

// Agents paste ANSI-colored terminal output into bodies; every control
// character must be stripped at store ingress (round 19: raw ESC bytes in
// cells / the title OSC strewed message text across the TUI).
test("ingress sanitization strips control chars from messages and sessions", () => {
  const dirty: Message = {
    id: "d1",
    kind: "ask",
    agent: "bot\x1b[31m",
    project: "proj\x07",
    body: "\x1b[31mred\x1b[0m line\nsecond\tline\x9b6n",
    context: "ctx\x1b]0;evil\x07",
    suggestion: "ok\x1b[2J",
    status: "pending",
    createdAt: now,
  }
  applyInit([dirty], [])
  const m = state.messages[0]!
  expect(m.agent).toBe("bot[31m")
  expect(m.project).toBe("proj")
  expect(m.body).toBe("[31mred[0m line\nsecondline6n") // \n kept, \t/C1 stripped
  expect(m.context).toBe("ctx]0;evil")
  expect(m.suggestion).toBe("ok[2J")

  addMessage({ ...dirty, id: "d2", body: "\x1b[2Jcleared?" })
  expect(state.messages[1]!.body).toBe("[2Jcleared?")

  const dirtySession: Session = {
    id: "s1",
    agent: "agent\x1b\\",
    project: "/p\x00",
    model: "m\x08",
    status: "needs-attention",
    detail: "needs\x1b[31m permission",
    bound: false,
    startedAt: now,
    lastSeen: now,
  }
  applyInit([], [dirtySession])
  const s = state.sessions[0]!
  expect(s.agent).toBe("agent\\")
  expect(s.project).toBe("/p")
  expect(s.detail).toBe("needs[31m permission")
  upsertSession({ ...dirtySession, id: "s2", detail: "d\x07x" })
  expect(state.sessions[1]!.detail).toBe("dx")

  expect(stripControls("a\x1b[31mb\nc\x07")).toBe("a[31mb\nc")
})

test("the terminal title never carries control characters", async () => {
  applyInit([], [])
  const titles: string[] = []
  const setup = await testRender(() => <App sendAnswer={() => true} />, { width: 100, height: 30 })
  ;(setup.renderer as unknown as { setTerminalTitle: (t: string) => void }).setTerminalTitle = (
    t: string,
  ) => titles.push(t)
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 30))
      await setup.renderOnce()
    }
  }
  await settle()
  // Even if a control-laden body somehow reached the store, the title effect
  // sanitizes again (belt-and-braces for the OSC egress).
  addMessage({
    id: "t1",
    kind: "ask",
    agent: "x",
    body: "\x1b[31mRED first line\x1b[0m tail\nsecond",
    status: "pending",
    createdAt: Date.now(),
  })
  await settle()
  const last = titles.at(-1) ?? ""
  expect(last).toBe("[31mRED first line[0m tail")
  // No title ever contains a control character.
  for (const t of titles) expect(/[\x00-\x1f\x7f-\x9f]/.test(t)).toBe(false)
}, 20_000)
