import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"
import { setPreview, setSessions, selected, setSelected } from "../src/store"

test("renders sessions with advertised status, selection moves, peek shows", async () => {
  setSessions([
    { name: "api", dir: "~/Repos/api", attached: true, windows: 2, status: "waiting", detail: "approve the plan?" },
    { name: "web", dir: "~/Repos/web", attached: false, windows: 1, status: "busy", detail: null },
    { name: "scratch", dir: "~", attached: false, windows: 1, status: null, detail: null },
  ])
  setSelected(0)
  setPreview(["$ bun test", "3 pass, 0 fail", "❯ waiting for input"])

  const setup = await testRender(() => <App poll={false} />, { width: 110, height: 30 })
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 20))
      await setup.renderOnce()
    }
  }
  await settle()
  let frame = setup.captureCharFrame()

  // Session rows: name, dir, advertised detail; peek header + captured lines.
  expect(frame).toContain("api")
  expect(frame).toContain("~/Repos/api")
  expect(frame).toContain("approve the plan?")
  expect(frame).toContain("2 windows · attached · waiting")
  expect(frame).toContain("waiting for input")
  expect(frame).toContain("⏎ open")

  // j/k + arrows move the selection, wrapping.
  setup.mockInput.pressKey("j")
  await settle()
  expect(selected()).toBe(1)
  setup.mockInput.pressKey("k")
  setup.mockInput.pressKey("k")
  await settle()
  expect(selected()).toBe(2)

  // x opens the kill confirmation; any key but y cancels.
  setup.mockInput.pressKey("x")
  await settle()
  frame = setup.captureCharFrame()
  expect(frame).toContain("kill session scratch?")
  setup.mockInput.pressKey("n")
  await settle()
  expect(setup.captureCharFrame()).not.toContain("kill session")
})
