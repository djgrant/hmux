import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { applyInit, drafts, loadDrafts, setDraft } from "../src/store"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("drafts persist to disk and reload; answered entries pruned", async () => {
  const path = join(
    process.env.TMPDIR ?? "/tmp",
    `humans-drafts-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  )
  loadDrafts(path) // no file yet: starts empty, enables persistence

  setDraft("d1", { text: "hello **world**", cursor: 5 })
  setDraft("d2+d3", { text: "merged draft", cursor: 3 }) // session-only key
  await sleep(400) // debounce is ~300ms

  const onDisk = JSON.parse(readFileSync(path, "utf8"))
  expect(onDisk.d1).toEqual({ text: "hello **world**", cursor: 5 })
  expect("d2+d3" in onDisk).toBe(false) // merged keys never persist

  // Round-trip: wipe memory, reload from disk.
  drafts.delete("d1")
  loadDrafts(path)
  expect(drafts.get("d1")).toEqual({ text: "hello **world**", cursor: 5 })

  // Messages that arrive answered prune their persisted draft.
  applyInit([
    {
      id: "d1",
      kind: "ask",
      agent: "bot",
      body: "q",
      status: "answered",
      answer: "a",
      createdAt: Date.now() - 1000,
      answeredAt: Date.now(),
    },
  ])
  expect(drafts.has("d1")).toBe(false)
  await sleep(400)
  expect("d1" in JSON.parse(readFileSync(path, "utf8"))).toBe(false)
})
