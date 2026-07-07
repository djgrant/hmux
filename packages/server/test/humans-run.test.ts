import { expect, test } from "bun:test"
import { buildRunConfig, parseArgs } from "../../cc-plugin/src/run"

test("buildRunConfig: identity headers, claude args, no permission skipping", () => {
  const cfg = buildRunConfig({
    task: "run the release script",
    cwd: "/Users/me/code/my-proj",
    base: "http://localhost:7999",
    agent: "release-bot",
    sessionId: "sid-1234"
  })
  expect(cfg.agent).toBe("release-bot")
  expect(cfg.project).toBe("/Users/me/code/my-proj")
  expect(cfg.mcpConfig.mcpServers.humans.type).toBe("http")
  expect(cfg.mcpConfig.mcpServers.humans.url).toBe("http://localhost:7999/mcp")
  expect(cfg.mcpConfig.mcpServers.humans.headers).toEqual({
    "x-humans-agent": "release-bot",
    "x-humans-project": "/Users/me/code/my-proj",
    "x-humans-session": "sid-1234"
  })
  const args = cfg.claudeArgs("/tmp/mcp.json")
  expect(args).toEqual([
    "-p",
    "run the release script",
    "--permission-prompt-tool",
    "mcp__humans__approve",
    "--mcp-config",
    "/tmp/mcp.json"
  ])
  expect(args).not.toContain("--dangerously-skip-permissions")
})

test("buildRunConfig: agent derives from cwd dirname + session id prefix", () => {
  const cfg = buildRunConfig({ task: "t", cwd: "/a/b/my-proj", sessionId: "abcd1234-x" })
  expect(cfg.agent).toBe("my-proj-abcd")
  expect(cfg.sessionId).toBe("abcd1234-x")
  // Without an explicit session id a UUID is generated.
  expect(buildRunConfig({ task: "t", cwd: "/a/b" }).sessionId).toMatch(/^[0-9a-f-]{36}$/)
})

test("parseArgs: task words joined; --agent extracted; bad usage rejected", () => {
  expect(parseArgs(["build", "the", "thing"])).toEqual({ task: "build the thing" })
  expect(parseArgs(["task", "--agent", "bot"])).toEqual({ task: "task", agent: "bot" })
  expect(parseArgs(["--agent", "bot", "do", "it"])).toEqual({ task: "do it", agent: "bot" })
  expect(parseArgs(["--agent"])).toBeNull() // missing value
  expect(parseArgs([])).toBeNull() // no task
})
