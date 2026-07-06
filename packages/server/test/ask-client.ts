// Manual e2e helper: sends a real MCP `ask` and prints the answer when it arrives.
// Usage: bun run test/ask-client.ts "question" [agent] [project]
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const port = Number(process.env.HUMANS_PORT ?? 7373)
const [question = "Test question?", agent = "test-agent", project] = process.argv.slice(2)

const client = new Client({ name: "ask-client", version: "0.0.0" })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)))
const result = await client.callTool(
  { name: "ask", arguments: { question, agent, ...(project ? { project } : {}) } },
  undefined,
  { timeout: 10 * 60_000, resetTimeoutOnProgress: true }
)
console.log("ANSWER:", JSON.stringify(result.content))
await client.close()
