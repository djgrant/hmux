import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"
import { applyInit } from "../src/store"

test("both panes painted edge to edge", async () => {
  applyInit([])
  const setup = await testRender(() => <App sendAnswer={() => true} />, { width: 100, height: 20 })
  await setup.renderOnce()
  const lines = setup.renderer.currentRenderBuffer.getSpanLines()
  // bg of the span covering column x on row y
  const probe = (x: number, y: number) => {
    let col = 0
    for (const span of lines[y]!.spans) {
      if (x < col + span.width) return [span.bg.r, span.bg.g, span.bg.b].map((v) => Math.round(v * 255)).join(",")
      col += span.width
    }
    return "?"
  }
  // Sidebar rgb(10,10,10): column 0 painted on the top, middle, and the very
  // last terminal row; last sidebar column too.
  expect(probe(0, 0)).toBe("10,10,10")
  expect(probe(0, 10)).toBe("10,10,10")
  expect(probe(0, 19)).toBe("10,10,10")
  expect(probe(29, 19)).toBe("10,10,10")
  // Main area rgb(21,26,29): painted top to bottom, including the footer row
  // and the last column.
  expect(probe(31, 0)).toBe("21,26,29")
  expect(probe(50, 10)).toBe("21,26,29")
  expect(probe(50, 19)).toBe("21,26,29")
  expect(probe(99, 19)).toBe("21,26,29")
})
