// Manual e2e helper: sends a real MCP `notify` (fire-and-forget, no answer).
// Usage: bun run test/notify-client.ts "message" [agent] [project]
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const port = Number(process.env.HMUX_PORT ?? 7373)
const [message = "Test notification", agent = "test-agent", project] = process.argv.slice(2)

const client = new Client({ name: "notify-client", version: "0.0.0" })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)))
const result = await client.callTool({
  name: "notify",
  arguments: { message, agent, ...(project ? { project } : {}) },
})
console.log("SENT:", JSON.stringify(result.content))
await client.close()
