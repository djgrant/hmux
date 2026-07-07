import { test, expect } from "bun:test"
import {
  NOTIFICATION_BYTE_BUDGET,
  applyTmuxNotificationOverride,
  createNotifier,
  detectTmuxOuterProtocol,
  formatNotification,
  truncateBytes,
} from "../src/notify"

test("formatNotification: agent prefix, first line only, sequences stripped, byte cap", () => {
  expect(formatNotification("deploy-bot", "Ship now?\nCI is green.")).toBe("deploy-bot: Ship now?")
  // ANSI sequences removed whole (no "[31m" litter); controls stripped; trimmed.
  expect(formatNotification("a", "\x1b[31mred\x07 bell\x9b ")).toBe("a: red bell")

  // Long bodies truncate to the BYTE budget: the notification travels as one
  // OSC envelope, and oversize payloads get their tail spilled literally on
  // partial writes (round 19b).
  const encoder = new TextEncoder()
  const long = formatNotification("agent", "x".repeat(500))
  expect(encoder.encode(long).byteLength).toBeLessThanOrEqual(NOTIFICATION_BYTE_BUDGET)
  expect(long.startsWith("agent: xxx")).toBe(true)
  expect(long.endsWith("…")).toBe(true)

  // Multibyte truncation lands on code-point boundaries: budget respected,
  // no split surrogates / replacement chars, em-dashes intact.
  const multibyte = formatNotification("agent", "—".repeat(200))
  expect(encoder.encode(multibyte).byteLength).toBeLessThanOrEqual(NOTIFICATION_BYTE_BUDGET)
  expect(multibyte.includes("�")).toBe(false)
  expect(multibyte).toMatch(/^agent: —+…$/)
  const astral = formatNotification("a", "😀".repeat(100))
  expect(encoder.encode(astral).byteLength).toBeLessThanOrEqual(NOTIFICATION_BYTE_BUDGET)
  expect(astral.includes("�")).toBe(false)

  // Under budget: untouched, no ellipsis.
  expect(truncateBytes("short", 120)).toBe("short")
  expect(formatNotification("bot", "")).toBe("bot: ")
})

test("notifier: unknown focus state notifies (never seen a focus event)", () => {
  const calls: Array<[string, string | undefined]> = []
  const notifier = createNotifier({ trigger: (m, t) => (calls.push([m, t]), true) })
  expect(notifier.notify("agent: hi")).toBe("os")
  expect(calls).toEqual([["agent: hi", "humans.sh"]])
})

test("notifier: focused skips, blurred notifies again", () => {
  const calls: string[] = []
  const bells: number[] = []
  const notifier = createNotifier({
    trigger: (m) => (calls.push(m), true),
    bell: () => bells.push(1),
  })
  notifier.onFocus()
  expect(notifier.notify("one")).toBe("skipped")
  expect(calls).toEqual([])
  notifier.onBlur()
  expect(notifier.notify("two")).toBe("os")
  expect(calls).toEqual(["two"])
  expect(bells).toEqual([])
})

test("notifier: BEL fallback when triggerNotification is unsupported", () => {
  const bells: number[] = []
  const notifier = createNotifier({ trigger: () => false, bell: () => bells.push(1) })
  expect(notifier.notify("hello")).toBe("bell")
  expect(bells).toEqual([1])
  // Still gated on focus: no bell while focused.
  notifier.onFocus()
  expect(notifier.notify("hello")).toBe("skipped")
  expect(bells).toEqual([1])
})

test("detectTmuxOuterProtocol: maps outer-terminal env fingerprints", () => {
  // iTerm2 → OSC 9, via session id or shell-integration LC_TERMINAL.
  expect(detectTmuxOuterProtocol({ ITERM_SESSION_ID: "w0t0p0:UUID" })).toBe("osc9")
  expect(detectTmuxOuterProtocol({ LC_TERMINAL: "iTerm2" })).toBe("osc9")
  // kitty → OSC 99.
  expect(detectTmuxOuterProtocol({ KITTY_WINDOW_ID: "1" })).toBe("osc99")
  expect(detectTmuxOuterProtocol({ KITTY_PID: "123" })).toBe("osc99")
  // WezTerm / Ghostty / VTE-based → OSC 777.
  expect(detectTmuxOuterProtocol({ WEZTERM_PANE: "0" })).toBe("osc777")
  expect(detectTmuxOuterProtocol({ GHOSTTY_RESOURCES_DIR: "/x" })).toBe("osc777")
  expect(detectTmuxOuterProtocol({ VTE_VERSION: "7802" })).toBe("osc777")
  // Unknown terminal: nothing forced, BEL fallback remains.
  expect(detectTmuxOuterProtocol({ TERM: "tmux-256color", TERM_PROGRAM: "tmux" })).toBe(null)
  // iTerm2 wins over a stale VTE fingerprint (specific beats generic).
  expect(detectTmuxOuterProtocol({ ITERM_SESSION_ID: "x", VTE_VERSION: "1" })).toBe("osc9")
})

test("applyTmuxNotificationOverride: forces protocol only inside tmux", () => {
  // Inside tmux + iTerm2 fingerprint → sets the env var OpenTUI honors.
  const env1: Record<string, string | undefined> = { TMUX: "/tmp/tmux-1/default,1,0", ITERM_SESSION_ID: "x" }
  expect(applyTmuxNotificationOverride(env1)).toBe("osc9")
  expect(env1.OPENTUI_NOTIFICATION_PROTOCOL).toBe("osc9")

  // Not in tmux → untouched (heuristics work fine there).
  const env2: Record<string, string | undefined> = { ITERM_SESSION_ID: "x" }
  expect(applyTmuxNotificationOverride(env2)).toBe(null)
  expect(env2.OPENTUI_NOTIFICATION_PROTOCOL).toBeUndefined()

  // Zellij (even with TMUX somehow set) → leave it to OpenTUI's zellij rules.
  expect(applyTmuxNotificationOverride({ TMUX: "x", ZELLIJ: "0", ITERM_SESSION_ID: "x" })).toBe(null)

  // User's explicit setting wins, including disables.
  const env3: Record<string, string | undefined> = { TMUX: "x", ITERM_SESSION_ID: "x", OPENTUI_NOTIFICATION_PROTOCOL: "none" }
  expect(applyTmuxNotificationOverride(env3)).toBe(null)
  expect(env3.OPENTUI_NOTIFICATION_PROTOCOL).toBe("none")

  // tmux but unknown outer terminal → nothing set, BEL fallback remains.
  const env4: Record<string, string | undefined> = { TMUX: "x", TERM: "tmux-256color" }
  expect(applyTmuxNotificationOverride(env4)).toBe(null)
  expect(env4.OPENTUI_NOTIFICATION_PROTOCOL).toBeUndefined()
})

test("notifier: custom title passes through", () => {
  const calls: Array<[string, string | undefined]> = []
  const notifier = createNotifier({ trigger: (m, t) => (calls.push([m, t]), true) })
  notifier.notify("body", "custom")
  expect(calls).toEqual([["body", "custom"]])
})
