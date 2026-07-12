// Long-blocking ask soak: verifies a token-less MCP ask survives well past
// fetch idle timeouts (~5 min) and resolves when the answer arrives late.
// Slow by design — opt in with: SOAK=1 bun test test/soak.test.ts
import { test, expect } from "bun:test"

const soakTest = test.skipIf(!process.env.SOAK)
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PORT = 7911 + 31
const ANSWER_AFTER_MS = 6.5 * 60_000

soakTest(
  "ask blocked 6.5 minutes resolves with late answer",
  async () => {
    process.env.HMUX_PORT = String(PORT)
    process.env.HMUX_DB = `/tmp/hmux-soak-${Date.now()}.db`
    await import("../src/index")

    const client = new Client({ name: "soak", version: "0.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`))
    )

    const t0 = Date.now()
    const askPromise = client.callTool(
      { name: "ask", arguments: { question: "soak?", agent: "soak-bot" } },
      undefined,
      { timeout: 10 * 60_000 }
    )

    setTimeout(() => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
      ws.onmessage = (e) => {
        const d = JSON.parse(String(e.data))
        if (d.type === "init") {
          const pending = d.messages.find((m: any) => m.status === "pending")
          if (pending) ws.send(JSON.stringify({ type: "answer", id: pending.id, text: "late answer" }))
        }
      }
    }, ANSWER_AFTER_MS)

    const result = await askPromise
    const elapsed = Math.round((Date.now() - t0) / 1000)
    console.log(`ask resolved after ${elapsed}s`)
    expect(elapsed).toBeGreaterThan(5 * 60)
    expect((result.content as any)[0].text).toBe("late answer")
  },
  9 * 60_000
)
