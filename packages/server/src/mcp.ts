import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Effect } from "effect"
import { z } from "zod"
import type { Message } from "@humans/protocol"
import { Hub } from "./hub"

type Runner = <A, E>(effect: Effect.Effect<A, E, Hub>) => Promise<A>

const PROGRESS_INTERVAL_MS = 20_000

const randomId = (prefix: string) => {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
  let suffix = ""
  for (let i = 0; i < 4; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return `${prefix}-${suffix}`
}

const buildServer = (run: Runner) => {
  // `logging` capability is required for the notifications/message keep-alives
  // that hold the HTTP stream open for token-less clients during a blocked ask.
  const server = new McpServer(
    { name: "humans", version: "0.0.0" },
    { capabilities: { logging: {} } }
  )

  server.registerTool(
    "ask",
    {
      title: "Ask the human operator",
      description:
        "Ask the human operator a question and wait for their reply. Use this whenever you " +
        "need a decision, clarification, credentials, or approval from the human. This call " +
        "BLOCKS until the human answers (there is no timeout), and the tool result is the " +
        "human's answer text.",
      inputSchema: {
        question: z.string().describe("The question to ask the human"),
        context: z
          .string()
          .optional()
          .describe("Optional extra context to help the human answer"),
        agent: z.string().optional().describe("Your agent name, if you have one"),
        project: z
          .string()
          .optional()
          .describe("The project you are working in (e.g. its directory)")
      }
    },
    async ({ question, context, agent, project }, extra) => {
      const message: Message = {
        id: crypto.randomUUID(),
        kind: "ask",
        agent: agent ?? randomId("agent"),
        ...(project !== undefined ? { project } : {}),
        body: question,
        ...(context !== undefined ? { context } : {}),
        status: "pending",
        createdAt: Date.now()
      }
      await run(Effect.flatMap(Hub, (hub) => hub.publishNew(message)))

      // Keep clients with idle timeouts alive while we wait for the human.
      const progressToken = extra._meta?.progressToken
      let ticks = 0
      const keepAlive = setInterval(() => {
        if (progressToken !== undefined) {
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: ++ticks,
                message: "Waiting for the human to answer..."
              }
            })
            .catch(() => {})
        } else {
          void extra
            .sendNotification({
              method: "notifications/message",
              params: { level: "debug", data: "humans.sh: waiting for the human to answer" }
            })
            .catch(() => {})
        }
      }, PROGRESS_INTERVAL_MS)

      try {
        const answer = await run(Effect.flatMap(Hub, (hub) => hub.awaitAnswer(message.id)))
        return { content: [{ type: "text", text: answer }] }
      } finally {
        clearInterval(keepAlive)
      }
    }
  )

  server.registerTool(
    "notify",
    {
      title: "Notify the human operator",
      description:
        "Send the human operator an FYI notification (progress updates, completions, " +
        "warnings). No reply is expected; this returns immediately.",
      inputSchema: {
        message: z.string().describe("The notification text"),
        agent: z.string().optional().describe("Your agent name, if you have one"),
        project: z
          .string()
          .optional()
          .describe("The project you are working in (e.g. its directory)")
      }
    },
    async ({ message, agent, project }) => {
      const record: Message = {
        id: crypto.randomUUID(),
        kind: "notify",
        agent: agent ?? randomId("agent"),
        ...(project !== undefined ? { project } : {}),
        body: message,
        status: "pending",
        createdAt: Date.now()
      }
      await run(Effect.flatMap(Hub, (hub) => hub.publishNew(record)))
      return { content: [{ type: "text", text: "Notification delivered to the human." }] }
    }
  )

  return server
}

/**
 * Stateless MCP over streamable HTTP: a fresh server + transport per request.
 * Returns a fetch-style handler for Bun.serve.
 */
export const makeMcpHandler = (run: Runner) => async (req: Request): Promise<Response> => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  })
  const server = buildServer(run)
  await server.connect(transport)
  return transport.handleRequest(req)
}
