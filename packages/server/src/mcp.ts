import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import { z } from "zod"
import type { Message } from "@humans/protocol"
import { Hub } from "./hub"

type Runner = <A, E>(effect: Effect.Effect<A, E, Hub>) => Promise<A>

// Overridable so tests can exercise keep-alive behaviour without 20s waits.
const PROGRESS_INTERVAL_MS = Number(process.env.HUMANS_PROGRESS_INTERVAL_MS) || 20_000

const randomId = (prefix: string) => {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
  let suffix = ""
  for (let i = 0; i < 4; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return `${prefix}-${suffix}`
}

/** The tool-handler `extra` as the SDK types it. */
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

/**
 * Keep blocked tool calls alive while waiting for the human. Two jobs per
 * tick: (1) a progress/logging notification so clients with idle timeouts
 * hold the HTTP stream open; (2) bump the matching session's last_seen so a
 * session blocked on ask/approve doesn't drift stale in the roster (no hooks
 * fire while a tool call is in flight). Only caller-provided agent names are
 * touched — randomId fallbacks match no session by construction.
 * Returns the stop function.
 */
const startKeepAlive = (
  run: Runner,
  extra: ToolExtra,
  waitingText: string,
  agent?: string,
  project?: string
): (() => void) => {
  const progressToken = extra._meta?.progressToken
  let ticks = 0
  const keepAlive = setInterval(() => {
    if (agent !== undefined) {
      void run(Effect.flatMap(Hub, (hub) => hub.touchSessionByAgent(agent, project))).catch(
        () => {}
      )
    }
    if (progressToken !== undefined) {
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: ++ticks, message: waitingText }
        })
        .catch(() => {})
    } else {
      void extra
        .sendNotification({
          method: "notifications/message",
          params: { level: "debug", data: `humans.sh: ${waitingText}` }
        })
        .catch(() => {})
    }
  }, PROGRESS_INTERVAL_MS)
  return () => clearInterval(keepAlive)
}

/**
 * Caller identity carried on the /mcp request as headers (the humans-run
 * wrapper and other integrations set them via mcp-config):
 *
 *   x-humans-agent    default agent name
 *   x-humans-project  default project
 *   x-humans-session  registered session id — resolves to that session's
 *                     agent/project and bumps its last_seen per tool call
 *
 * Tool ARGS always win over headers; headers win over the random fallback.
 */
export interface McpIdentity {
  agent?: string
  project?: string
  session?: string
}

const buildServer = (run: Runner, identity: McpIdentity = {}) => {
  /**
   * Resolve the effective default identity for one tool call. The session
   * header is authoritative when it resolves (registration is the source of
   * truth for names) and doubles as a liveness touch.
   */
  const resolveIdentity = async (): Promise<{ agent?: string; project?: string }> => {
    if (identity.session !== undefined) {
      const session = await run(
        Effect.flatMap(Hub, (hub) => hub.touchSession(identity.session!))
      )
      if (session) {
        return { agent: session.agent, project: session.project ?? identity.project }
      }
    }
    return { agent: identity.agent, project: identity.project }
  }

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
        suggestion: z
          .string()
          .optional()
          .describe(
            "A short suggested answer the human can accept with one key, e.g. 'ok' or 'yes, proceed'"
          ),
        agent: z.string().optional().describe("Your agent name, if you have one"),
        project: z
          .string()
          .optional()
          .describe("The project you are working in (e.g. its directory)")
      }
    },
    async ({ question, context, suggestion, agent, project }, extra) => {
      const header = await resolveIdentity()
      const effectiveAgent = agent ?? header.agent
      const effectiveProject = project ?? header.project
      const message: Message = {
        id: crypto.randomUUID(),
        kind: "ask",
        agent: effectiveAgent ?? randomId("agent"),
        ...(effectiveProject !== undefined ? { project: effectiveProject } : {}),
        body: question,
        ...(context !== undefined ? { context } : {}),
        ...(suggestion !== undefined ? { suggestion } : {}),
        status: "pending",
        createdAt: Date.now()
      }
      await run(Effect.flatMap(Hub, (hub) => hub.publishNew(message)))

      const stopKeepAlive = startKeepAlive(
        run,
        extra,
        "Waiting for the human to answer...",
        effectiveAgent,
        effectiveProject
      )
      try {
        const answer = await run(Effect.flatMap(Hub, (hub) => hub.awaitAnswer(message.id)))
        return { content: [{ type: "text", text: answer }] }
      } finally {
        stopKeepAlive()
      }
    }
  )

  server.registerTool(
    "approve",
    {
      title: "Ask the human to approve a tool use",
      description:
        "Permission-prompt tool for headless Claude Code sessions (pass " +
        "--permission-prompt-tool mcp__humans__approve). Sends the requested tool use to " +
        "the human inbox and BLOCKS until they allow or deny it. Returns the " +
        "permission-result JSON Claude Code expects.",
      inputSchema: {
        tool_name: z.string().describe("Name of the tool requesting permission"),
        input: z.record(z.string(), z.unknown()).describe("The input the tool will receive"),
        tool_use_id: z.string().optional().describe("The unique tool use request ID"),
        agent: z.string().optional().describe("Your agent name, if you have one"),
        project: z
          .string()
          .optional()
          .describe("The project you are working in (e.g. its directory)")
      }
    },
    async ({ tool_name, input, tool_use_id: _toolUseId, agent, project }, extra) => {
      // Claude Code calls this tool itself with only tool_name/input/
      // tool_use_id — identity comes from the request headers (humans-run).
      const header = await resolveIdentity()
      const effectiveAgent = agent ?? header.agent
      const effectiveProject = project ?? header.project
      // Human-readable body: what the agent wants to run, input as a fence.
      const message: Message = {
        id: crypto.randomUUID(),
        kind: "approval",
        agent: effectiveAgent ?? randomId("agent"),
        ...(effectiveProject !== undefined ? { project: effectiveProject } : {}),
        body: `wants to run ${tool_name}\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``,
        suggestion: "allow",
        status: "pending",
        createdAt: Date.now()
      }
      await run(Effect.flatMap(Hub, (hub) => hub.publishNew(message)))

      const stopKeepAlive = startKeepAlive(
        run,
        extra,
        "Waiting for the human to approve...",
        effectiveAgent,
        effectiveProject
      )
      try {
        const answer = await run(Effect.flatMap(Hub, (hub) => hub.awaitAnswer(message.id)))
        // Claude Code's permission-prompt contract: JSON *as text content*.
        // Exactly "allow" approves (updatedInput is optional; echoing the
        // original input back is the no-modification case); ANY other text
        // is a denial whose text goes to the model as the reason.
        const allowed = answer.trim().toLowerCase() === "allow"
        const result = allowed
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: answer }
        return { content: [{ type: "text", text: JSON.stringify(result) }] }
      } finally {
        stopKeepAlive()
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
      const header = await resolveIdentity()
      const effectiveProject = project ?? header.project
      const record: Message = {
        id: crypto.randomUUID(),
        kind: "notify",
        agent: agent ?? header.agent ?? randomId("agent"),
        ...(effectiveProject !== undefined ? { project: effectiveProject } : {}),
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
  // Per-request server: the caller's identity headers close over the tool
  // handlers for exactly this request.
  const identity: McpIdentity = {
    agent: req.headers.get("x-humans-agent") ?? undefined,
    project: req.headers.get("x-humans-project") ?? undefined,
    session: req.headers.get("x-humans-session") ?? undefined
  }
  const server = buildServer(run, identity)
  await server.connect(transport)
  return transport.handleRequest(req)
}
