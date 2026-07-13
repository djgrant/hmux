import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readTranscript, transcriptFromResume } from "../src/transcript"

const dir = mkdtempSync(join(tmpdir(), "hhmux-transcript-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const line = (o: unknown) => JSON.stringify(o)
const fixture = [
  line({ type: "mode", mode: "normal" }),
  line({ type: "file-history-snapshot", snapshot: {} }),
  line({
    type: "user",
    timestamp: "t1",
    message: { role: "user", content: "fix the locking bug" },
  }),
  line({
    type: "assistant",
    timestamp: "t2",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Looking at the lock." },
        { type: "tool_use", name: "Read", input: { file_path: "/x" } },
      ],
    },
  }),
  line({
    type: "user",
    timestamp: "t3",
    message: {
      role: "user",
      content: [{ type: "tool_result", content: [{ type: "text", text: "file contents here" }] }],
    },
  }),
  "not json at all {{{",
  line({
    type: "assistant",
    timestamp: "t4",
    message: { role: "assistant", content: [{ type: "text", text: "Found it: a stale flock." }] },
  }),
].join("\n")

async function write(name: string, content: string): Promise<string> {
  const path = join(dir, name)
  await Bun.write(path, content)
  return path
}

describe("readTranscript", () => {
  test("returns conversational turns, skipping plumbing and malformed lines", async () => {
    const turns = await readTranscript(await write("a.jsonl", fixture))
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant"])
    expect(turns[0].text).toBe("fix the locking bug")
    expect(turns[1].tools).toEqual(["Read"])
    expect(turns[1].text).toBe("Looking at the lock.") // thinking excluded
  })

  test("tool results are elided by default and included on request", async () => {
    const path = await write("b.jsonl", fixture)
    const bare = await readTranscript(path)
    expect(bare.some((t) => t.text.includes("file contents"))).toBe(false)
    const full = await readTranscript(path, { includeToolResults: true })
    expect(full.some((t) => t.text.includes("file contents here"))).toBe(true)
  })

  test("turns limits from the tail", async () => {
    const turns = await readTranscript(await write("c.jsonl", fixture), { turns: 1 })
    expect(turns).toHaveLength(1)
    expect(turns[0].text).toContain("stale flock")
  })
})

describe("transcriptFromResume", () => {
  test("no session id in the command yields null", async () => {
    expect(await transcriptFromResume("claude")).toBeNull()
  })

  test("extracts the id and globs for it", async () => {
    // No real transcript with this id exists, so the glob comes up empty.
    expect(await transcriptFromResume("claude --resume zzzz-not-a-real-id")).toBeNull()
  })
})
