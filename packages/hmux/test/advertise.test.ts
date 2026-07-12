import { describe, expect, test } from "bun:test"
import { parseAdvertiseArgs } from "../src/advertise"

describe("parseAdvertiseArgs", () => {
  test("status without detail clears the detail", () => {
    expect(parseAdvertiseArgs(["--status", "busy"])).toEqual({ status: "busy", detail: null })
  })

  test("status with detail sets both", () => {
    expect(parseAdvertiseArgs(["--status", "message", "--detail", "approve?"])).toEqual({
      status: "message",
      detail: "approve?",
    })
  })

  test("agent and resume pass through without touching status", () => {
    expect(parseAdvertiseArgs(["--resume", "claude --resume abc"])).toEqual({
      resume: "claude --resume abc",
    })
    expect(parseAdvertiseArgs(["--agent", "api-3f2c · sonnet"])).toEqual({
      agent: "api-3f2c · sonnet",
    })
  })

  test("--clear unsets every field", () => {
    expect(parseAdvertiseArgs(["--clear"])).toEqual({
      status: null,
      detail: null,
      agent: null,
      resume: null,
    })
  })

  test("bad usage returns null", () => {
    expect(parseAdvertiseArgs([])).toBeNull()
    expect(parseAdvertiseArgs(["--status"])).toBeNull()
    expect(parseAdvertiseArgs(["--nope", "x"])).toBeNull()
    expect(parseAdvertiseArgs(["--clear", "--status", "busy"])).toBeNull()
  })
})
