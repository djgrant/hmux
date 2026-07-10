import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"
import { setGroups, selected, setSelected, updateQuery, rows, selectedRow, fuzzyScore, selectTarget, moveSelection, setBackend, refresh, jumpToNeedsYou } from "../src/store"
import type { Backend, DisplayTarget, SessionGroup } from "../src/backend"

const opened: string[] = []
const openedInClient: Array<[string, string]> = []
const peeked: Array<[string, string]> = []
let liveTargets: DisplayTarget[] = []
const killed: string[] = []
const created: string[] = []
const renamed: Array<[string, string]> = []
const fakeBackend: Backend = {
  list: async () => [],
  open: async (t) => void opened.push(t),
  opensInPlace: () => true,
  targets: async () => liveTargets,
  openInClient: async (t, c) => void openedInClient.push([t, c.tty]),
  peekInClient: async (t, c) => void peeked.push([t, c.tty]),
  create: async (n) => void created.push(n),
  rename: async (t, to) => void renamed.push([t, to]),
  kill: async (s) => void killed.push(s),
}

function seed() {
  setGroups([
    {
      target: "api",
      name: "api",
      dir: "~/Repos/api",
      attached: true,
      status: "message",
      detail: "approve the plan?",
      windows: [
        { target: "api:1", session: "api", name: "claude", dir: "~/Repos/api", agent: "api-3f2c · sonnet", active: true, paneCount: 2, status: "message", detail: "approve the plan?" },
        { target: "api:2", session: "api", name: "server", dir: "~/Repos/api", agent: null, active: false, paneCount: 1, status: "busy", detail: null },
      ],
    },
    {
      target: "web",
      name: "web",
      dir: "~/Repos/web",
      attached: false,
      status: null,
      detail: null,
      windows: [{ target: "web:1", session: "web", name: "zsh", dir: "~/Repos/web", agent: null, active: true, paneCount: 1, status: null, detail: null }],
    },
  ])
  updateQuery("")
  setSelected(0)
}

test("two-tier rows, typeahead flattening, open and kill", async () => {
  seed()
  const setup = await testRender(() => <App backend={fakeBackend} poll={false} />, {
    width: 110,
    height: 30,
  })
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 20))
      await setup.renderOnce()
    }
  }
  await settle()
  let frame = setup.captureCharFrame()

  // Tree view: api (2 windows → header + 2 rows), web single-window collapses.
  expect(rows().map((r) => r.target)).toEqual(["api", "api:1", "api:2", "web"])
  expect(frame).toContain("approve the plan?")
  expect(frame).toContain("⌥↑↓ peek")
  // Window rows are labelled by tmux window name; the advertised agent
  // identity and pane count are not displayed (agent stays searchable).
  expect(frame).toContain("claude")
  expect(frame).toContain("server")
  expect(frame).not.toContain("api-3f2c")
  expect(frame).not.toContain("2 panes")

  // Typeahead flattens to ranked windows: "cl" matches api's claude window
  // (and the invisible agent identity is searchable too).
  setup.mockInput.typeText("cl")
  await settle()
  expect(rows()[0]?.target).toBe("api:1")
  expect(rows().every((r) => r.kind === "window")).toBe(true)

  // Enter opens the top match.
  setup.mockInput.pressEnter()
  await settle()
  expect(opened).toEqual(["api:1"])

  // With a display target registered, open routes there instead and the
  // picker stays up.
  liveTargets = [{ tty: "/dev/ttys009", program: "iTerm.app" }]
  setup.mockInput.pressEnter()
  await settle()
  expect(openedInClient).toEqual([["api:1", "/dev/ttys009"]])
  expect(opened).toEqual(["api:1"]) // unchanged
  liveTargets = []

  // Escape clears the query; tree view restores. The cursor stays on the
  // session that was open (api:1), it does not snap back to the top.
  setup.mockInput.pressEscape()
  await settle()
  expect(rows().length).toBe(4)
  expect(selectedRow()?.target).toBe("api:1")

  // Arrow selection + ctrl+x kill confirm flow. On a window row it kills just
  // that window (target "session:index"), not the whole session.
  setup.mockInput.pressArrow("down")
  await settle()
  expect(selectedRow()?.target).toBe("api:2")
  setup.mockInput.pressKey("x", { ctrl: true })
  await settle()
  expect(setup.captureCharFrame()).toContain("kill window server?")
  setup.mockInput.pressKey("y")
  await settle()
  expect(killed).toEqual(["api:2"])
})

test("prompt overlay: ^n creates, ^r renames", async () => {
  seed()
  const setup = await testRender(() => <App backend={fakeBackend} poll={false} />, {
    width: 110,
    height: 30,
  })
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 20))
      await setup.renderOnce()
    }
  }
  await settle()
  setup.mockInput.pressKey("n", { ctrl: true })
  await settle()
  expect(setup.captureCharFrame()).toContain("new session name")
  setup.mockInput.typeText("foo")
  await settle()
  setup.mockInput.pressEnter()
  await settle()
  expect(created).toEqual(["foo"])

  // ^r on a window row renames the window (target "session:index").
  setup.mockInput.pressArrow("down")
  await settle()
  setup.mockInput.pressKey("r", { ctrl: true })
  await settle()
  expect(setup.captureCharFrame()).toContain("rename window claude")
  setup.mockInput.pressEnter()
  await settle()
  expect(renamed[0]?.[0]).toBe("api:1")
})

test("parked cursor follows the attached session's active window", async () => {
  const w = (target: string, name: string, active: boolean) => ({
    target, session: "api", name, dir: "~/Repos/api", agent: null, active, paneCount: 1, status: null, detail: null,
  })
  const group = (activeIndex: 1 | 2): SessionGroup[] => [{
    target: "api", name: "api", dir: "~/Repos/api", attached: true, status: null, detail: null,
    windows: [w("api:1", "claude", activeIndex === 1), w("api:2", "server", activeIndex === 2)],
  }]
  let list = group(1)
  setBackend({ ...fakeBackend, list: async () => list })

  setGroups(list)
  updateQuery("")
  selectTarget("api:1") // opening parks the cursor
  await refresh()
  expect(selectedRow()?.target).toBe("api:1")

  // A window switch in the attached session propagates on the next poll.
  list = group(2)
  await refresh()
  expect(selectedRow()?.target).toBe("api:2")

  // Browsing unparks: the cursor is never yanked mid-navigation.
  moveSelection(-1)
  expect(selectedRow()?.target).toBe("api:1")
  list = group(1) // active flips back to api:1 while cursor sits on it...
  moveSelection(1) // ...but the user has moved on to api:2
  list = group(1)
  await refresh()
  expect(selectedRow()?.target).toBe("api:2")
})

test("left/right jump to sessions with an advertised agent, skipping bare shells", async () => {
  // web (busy) · shell (unadvertised, skipped) · ops (error).
  setGroups([
    { target: "web", name: "web", dir: "~", attached: false, status: "busy", detail: null,
      windows: [{ target: "web:1", session: "web", name: "claude", dir: "~", agent: null, active: true, paneCount: 1, status: "busy", detail: null }] },
    { target: "shell", name: "shell", dir: "~", attached: false, status: null, detail: null,
      windows: [{ target: "shell:1", session: "shell", name: "zsh", dir: "~", agent: null, active: true, paneCount: 1, status: null, detail: null }] },
    { target: "ops", name: "ops", dir: "~", attached: false, status: "error", detail: null,
      windows: [{ target: "ops:1", session: "ops", name: "zsh", dir: "~", agent: null, active: true, paneCount: 1, status: "error", detail: null }] },
  ])
  updateQuery("")
  setSelected(0)
  // Only session headers count, and the unadvertised shell is skipped. From
  // web, right lands on ops; right again wraps to web.
  expect(rows().map((r) => r.target)).toEqual(["web", "shell", "ops"])
  jumpToNeedsYou(1)
  expect(selectedRow()?.target).toBe("ops")
  jumpToNeedsYou(1)
  expect(selectedRow()?.target).toBe("web")
  // Left walks back the other way, wrapping to ops.
  jumpToNeedsYou(-1)
  expect(selectedRow()?.target).toBe("ops")
})

test("fuzzyScore: substring beats subsequence, misses rejected", () => {
  expect(fuzzyScore("api claude", "claude")).toBeGreaterThan(fuzzyScore("api claude", "acl"))
  expect(fuzzyScore("api claude", "acl")).toBeGreaterThan(0)
  expect(fuzzyScore("api claude", "xyz")).toBe(-1)
})
