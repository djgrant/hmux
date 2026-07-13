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

// pi writes one "message" entry per turn, with the role on message.role, tool
// calls as "toolCall" blocks, and tool results as their own "toolResult"
// entries — see session-format.md.
const piFixture = [
  line({ type: "session", version: 3, id: "uuid", cwd: "/x" }),
  line({ type: "model_change", provider: "anthropic", modelId: "claude-sonnet-4-5" }),
  line({
    type: "message",
    timestamp: "t1",
    message: { role: "user", content: "fix the locking bug" },
  }),
  line({
    type: "message",
    timestamp: "t2",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Looking at the lock." },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } },
      ],
    },
  }),
  line({
    type: "message",
    timestamp: "t3",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "file contents here" }],
      isError: false,
    },
  }),
  line({
    type: "custom_message",
    timestamp: "t3b",
    customType: "hmux-bound",
    content: "bound plumbing, not conversation",
  }),
  line({
    type: "message",
    timestamp: "t4",
    message: { role: "assistant", content: [{ type: "text", text: "Found it: a stale flock." }] },
  }),
].join("\n")

describe("readTranscript (pi schema)", () => {
  test("parses pi 'message' entries, toolCall names, and skips plumbing", async () => {
    const turns = await readTranscript(await write("pi.jsonl", piFixture))
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant"])
    expect(turns[0].text).toBe("fix the locking bug")
    expect(turns[1].tools).toEqual(["read"]) // toolCall block, not tool_use
    expect(turns[1].text).toBe("Looking at the lock.") // thinking excluded
    // custom_message plumbing never surfaces as a turn
    expect(turns.some((t) => t.text.includes("bound plumbing"))).toBe(false)
  })

  test("pi tool results are elided by default and included on request", async () => {
    const path = await write("pi.jsonl", piFixture)
    const bare = await readTranscript(path)
    expect(bare.some((t) => t.text.includes("file contents"))).toBe(false)
    const full = await readTranscript(path, { includeToolResults: true })
    const resultTurn = full.find((t) => t.text.includes("file contents here"))
    expect(resultTurn).toBeDefined()
    // the resolved tool is surfaced from message.toolName
    expect(resultTurn?.tools).toEqual(["read"])
  })
})

describe("transcriptFromResume", () => {
  test("no session id in the command yields null", async () => {
    expect(await transcriptFromResume("claude")).toBeNull()
    expect(await transcriptFromResume("pi")).toBeNull()
  })

  test("extracts the id and globs for it", async () => {
    // No real transcript with these ids exists, so the glob comes up empty.
    expect(await transcriptFromResume("claude --resume zzzz-not-a-real-id")).toBeNull()
    expect(await transcriptFromResume("pi --session zzzz-not-a-real-id")).toBeNull()
  })
})
