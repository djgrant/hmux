import { describe, expect, test } from "bun:test"
import { parseWaitArgs, waitForSettle } from "../src/wait"

/** A poll that walks a scripted sequence of statuses, holding the last. */
function scripted(sequence: Array<string | null | undefined>) {
  let i = 0
  return async () => sequence[Math.min(i++, sequence.length - 1)]
}

const fast = { pollMs: 1, graceMs: 30 }

describe("waitForSettle", () => {
  test("settles on a busy→settled transition", async () => {
    const result = await waitForSettle(scripted(["busy", "busy", "message"]), fast)
    expect(result).toEqual({ outcome: "settled", status: "message" })
  })

  test("does not settle before observing busy within the grace period", async () => {
    // idle at arm time (the send→pickup race), then the agent starts and finishes
    const result = await waitForSettle(scripted(["idle", "idle", "busy", "error"]), fast)
    expect(result).toEqual({ outcome: "settled", status: "error" })
  })

  test("a never-busy target settles once the grace period passes", async () => {
    const result = await waitForSettle(scripted(["idle"]), fast)
    expect(result).toEqual({ outcome: "settled", status: "idle" })
  })

  test("null status (nothing advertised) settles as null after grace", async () => {
    const result = await waitForSettle(scripted([null]), fast)
    expect(result).toEqual({ outcome: "settled", status: null })
  })

  test("times out while the target stays busy", async () => {
    const result = await waitForSettle(scripted(["busy"]), { ...fast, timeoutMs: 20 })
    expect(result).toEqual({ outcome: "timeout" })
  })

  test("reports a vanished target", async () => {
    const result = await waitForSettle(scripted(["busy", undefined]), fast)
    expect(result).toEqual({ outcome: "gone" })
  })
})

describe("parseWaitArgs", () => {
  test("target alone", () => {
    expect(parseWaitArgs(["api:1"])).toEqual({ target: "api:1", timeoutMs: 0 })
  })

  test("--timeout in seconds", () => {
    expect(parseWaitArgs(["api:1", "--timeout", "30"])).toEqual({ target: "api:1", timeoutMs: 30000 })
  })

  test("bad usage returns null", () => {
    expect(parseWaitArgs([])).toBeNull()
    expect(parseWaitArgs(["--timeout", "30"])).toBeNull()
    expect(parseWaitArgs(["api:1", "--timeout"])).toBeNull()
    expect(parseWaitArgs(["api:1", "--timeout", "soon"])).toBeNull()
    expect(parseWaitArgs(["api:1", "--nope", "1"])).toBeNull()
  })
})
