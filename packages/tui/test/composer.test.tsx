import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"
import { applyInit, drafts, state } from "../src/store"
import type { Message } from "@humans/protocol"

const now = Date.now()
const messages: Message[] = [
  { id: "c1", kind: "ask", agent: "bot-a", project: "p", body: "first?", status: "pending", createdAt: now - 60_000 },
  { id: "c2", kind: "ask", agent: "bot-b", project: "p", body: "second?", status: "pending", createdAt: now - 30_000 },
]

test("shift+↑↓ cycles the current message in place; modified returns newline", async () => {
  const sent: Array<[string, string]> = []
  applyInit(messages)
  const setup = await testRender(
    () => <App sendAnswer={(id, text) => (sent.push([id, text]), true)} />,
    { width: 110, height: 30 },
  )
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 30))
      await setup.renderOnce()
    }
  }
  const raw = (seq: string) => (setup.renderer as any).stdin.emit("data", Buffer.from(seq))
  await settle()

  // --- Item 1: in-place message switching -----------------------------------
  expect(state.currentId).toBe("c1")
  setup.mockInput.typeText("abc")
  await settle()
  expect(drafts.get("c1")).toEqual({ text: "abc", cursor: 3 })

  // shift+↓: current switches to c2, focus NEVER leaves the composer, the
  // sidebar highlight follows, and no key leaks into the fresh textarea.
  setup.mockInput.pressArrow("down", { shift: true })
  await settle()
  expect(state.focus).toBe("composer")
  expect(state.currentId).toBe("c2")
  expect(state.highlightId).toBe("c2")
  expect(drafts.get("c2")?.text ?? "").toBe("") // no leakage from the event

  // The remounted textarea is focused: typing lands in c2's draft only.
  setup.mockInput.typeText("xyz")
  await settle()
  expect(drafts.get("c2")).toEqual({ text: "xyz", cursor: 3 })
  expect(drafts.get("c1")).toEqual({ text: "abc", cursor: 3 }) // preserved

  // shift+↑ wraps back; c1's draft (and cursor) restore in the textarea.
  setup.mockInput.pressArrow("up", { shift: true })
  await settle()
  expect(state.currentId).toBe("c1")
  expect(state.focus).toBe("composer")
  expect(setup.captureCharFrame()).toContain("abc")
  setup.mockInput.typeText("!")
  await settle()
  expect(drafts.get("c1")).toEqual({ text: "abc!", cursor: 4 }) // cursor was at end

  // --- Item 2: every modified return means newline, never submit ------------
  // kitty protocol shift+return (Ghostty/kitty): CSI 13;2u
  raw("\x1b[13;2u")
  await settle()
  expect(sent).toEqual([])
  expect(drafts.get("c1")?.text).toBe("abc!\n")
  // kitty with associated-text field variant: CSI 13;2;13u
  raw("\x1b[13;2;13u")
  await settle()
  expect(sent).toEqual([])
  expect(drafts.get("c1")?.text).toBe("abc!\n\n")
  // modifyOtherKeys (xterm/iTerm2): CSI 27;2;13~
  raw("\x1b[27;2;13~")
  await settle()
  expect(sent).toEqual([])
  expect(drafts.get("c1")?.text).toBe("abc!\n\n\n")
  // ESC CR (meta+return): what Ghostty/iTerm "shift+enter" user keybinds and
  // tmux setups send in legacy mode. OpenTUI's default maps this to submit;
  // our override must newline instead.
  raw("\x1b\r")
  await settle()
  expect(sent).toEqual([])
  expect(drafts.get("c1")?.text).toBe("abc!\n\n\n\n")

  // Plain ⏎ is still the one and only submit.
  setup.mockInput.pressEnter()
  await settle()
  expect(sent).toEqual([["c1", "abc!\n\n\n\n"]])
  expect(state.currentId).toBe("c2")

  // --- Dead-keyboard resilience ---------------------------------------------
  // c2's draft ("xyz", cursor 3) is restored in the remounted composer.
  // Click on the message body: OpenTUI scrollboxes are focusable by default
  // and click-to-focus would steal renderable focus from the textarea — our
  // focusable=false override keeps typing alive.
  await setup.mockMouse.click(60, 3)
  await settle()
  setup.mockInput.typeText("!")
  await settle()
  expect(drafts.get("c2")).toEqual({ text: "xyz!", cursor: 4 })

  // Simulated focus steal (whatever the cause): typing goes dead; the
  // terminal focus event must re-assert composer focus so typing resumes.
  setup.renderer.currentFocusedRenderable?.blur()
  await settle()
  setup.mockInput.typeText("?")
  await settle()
  expect(drafts.get("c2")?.text).toBe("xyz!") // proves keys were dead
  setup.renderer.emit("focus")
  await settle()
  setup.mockInput.typeText("?")
  await settle()
  expect(drafts.get("c2")).toEqual({ text: "xyz!?", cursor: 5 })
}, 20_000)
