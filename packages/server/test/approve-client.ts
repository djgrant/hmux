// Manual e2e helper: sends a real MCP `approve` (permission-prompt contract)
// and prints the permission-result JSON when the human answers.
// Usage: bun run test/approve-client.ts [tool_name] [agent]
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const port = Number(process.env.HUMANS_PORT ?? 7373)
const [toolName = "Bash", agent = "headless-e2e"] = process.argv.slice(2)

const client = new Client({ name: "approve-client", version: "0.0.0" })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)))
const result = await client.callTool(
  {
    name: "approve",
    arguments: {
      tool_name: toolName,
      input: { command: "rm -rf dist" },
      tool_use_id: "tu-e2e-1",
      agent,
      project: "humans.sh"
    }
  },
  undefined,
  { timeout: 10 * 60_000, resetTimeoutOnProgress: true }
)
console.log("RESULT:", JSON.stringify(result.content))
await client.close()
