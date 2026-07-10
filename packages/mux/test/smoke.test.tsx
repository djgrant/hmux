import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"
import { setGroups, selected, setSelected, updateQuery, rows, selectedRow, fuzzyScore } from "../src/store"
import type { Backend, DisplayTarget } from "../src/backend"

const opened: string[] = []
const openedInClient: Array<[string, string]> = []
const peeked: Array<[string, string]> = []
let liveTargets: DisplayTarget[] = []
const killed: string[] = []
const fakeBackend: Backend = {
  list: async () => [],
  open: async (t) => void opened.push(t),
  opensInPlace: () => true,
  targets: async () => liveTargets,
  openInClient: async (t, c) => void openedInClient.push([t, c.tty]),
  peekInClient: async (t, c) => void peeked.push([t, c.tty]),
  create: async () => {},
  rename: async () => {},
  kill: async (s) => void killed.push(s),
}

function seed() {
  setGroups([
    {
      target: "api",
      name: "api",
      dir: "~/Repos/api",
      attached: true,
      status: "waiting",
      detail: "approve the plan?",
      windows: [
        { target: "api:1", session: "api", name: "claude", dir: "~/Repos/api", agent: "api-3f2c · sonnet", paneCount: 2, status: "waiting", detail: "approve the plan?" },
        { target: "api:2", session: "api", name: "server", dir: "~/Repos/api", agent: null, paneCount: 1, status: "busy", detail: null },
      ],
    },
    {
      target: "web",
      name: "web",
      dir: "~/Repos/web",
      attached: false,
      status: null,
      detail: null,
      windows: [{ target: "web:1", session: "web", name: "zsh", dir: "~/Repos/web", agent: null, paneCount: 1, status: null, detail: null }],
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
  // Window meta: advertised agent identity + pane count; single-window
  // sessions carry their window meta up to the collapsed header row.
  expect(frame).toContain("api-3f2c · sonnet")
  expect(frame).toContain("2 panes")

  // Typeahead flattens to ranked windows: "cl" matches api's claude window.
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

  // Escape clears the query; tree view restores.
  setup.mockInput.pressEscape()
  await settle()
  expect(rows().length).toBe(4)

  // Arrow selection + ctrl+x kill confirm flow.
  setup.mockInput.pressArrow("down")
  await settle()
  expect(selectedRow()?.target).toBe("api:1")
  setup.mockInput.pressKey("x", { ctrl: true })
  await settle()
  expect(setup.captureCharFrame()).toContain("kill session api?")
  setup.mockInput.pressKey("y")
  await settle()
  expect(killed).toEqual(["api"])
})

test("fuzzyScore: substring beats subsequence, misses rejected", () => {
  expect(fuzzyScore("api claude", "claude")).toBeGreaterThan(fuzzyScore("api claude", "acl"))
  expect(fuzzyScore("api claude", "acl")).toBeGreaterThan(0)
  expect(fuzzyScore("api claude", "xyz")).toBe(-1)
})
