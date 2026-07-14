import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import { z } from "zod"
import type { Message } from "@hmux/protocol"
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
          params: { level: "debug", data: `hmux: ${waitingText}` }
        })
        .catch(() => {})
    }
  }, PROGRESS_INTERVAL_MS)
  return () => clearInterval(keepAlive)
}

/**
 * Caller identity carried on the /mcp request as headers (integrations set
 * them via mcp-config):
 *
 *   x-hmux-agent    default agent name
 *   x-hmux-project  default project
 *   x-hmux-session  registered session id — resolves to that session's
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
   * Resolve the effective identity for one tool call. A registered session —
   * via the harness-stamped sessionId arg or the x-hmux-session header — is
   * AUTHORITATIVE: its agent/project override anything the model wrote in the
   * tool args, so an agent cannot impersonate another by lying in params.
   * Resolving also doubles as a liveness touch. Without a registered session,
   * args win over headers over the random fallback (the un-hooked MCP path).
   */
  const resolveIdentity = async (
    sessionId: string | undefined
  ): Promise<{ agent?: string; project?: string; trusted: boolean }> => {
    const sid = sessionId ?? identity.session
    if (sid !== undefined) {
      const session = await run(Effect.flatMap(Hub, (hub) => hub.touchSession(sid)))
      if (session) {
        return { agent: session.agent, project: session.project, trusted: true }
      }
    }
    return { agent: identity.agent, project: identity.project, trusted: false }
  }

  const sessionIdSchema = z
    .string()
    .optional()
    .describe(
      "Your hmux session id (the Claude Code plugin stamps this automatically; " +
        "leave unset otherwise)"
    )

  /** Apply the trust precedence: registered session > model args > headers. */
  const effectiveIdentity = (
    resolved: { agent?: string; project?: string; trusted: boolean },
    agent: string | undefined,
    project: string | undefined
  ) => ({
    agent: resolved.trusted ? resolved.agent : (agent ?? resolved.agent),
    project: resolved.trusted ? (resolved.project ?? project) : (project ?? resolved.project)
  })

  // `logging` capability is required for the notifications/message keep-alives
  // that hold the HTTP stream open for token-less clients during a blocked ask.
  const server = new McpServer(
    { name: "hmux", version: "0.0.0" },
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
          .describe("The project you are working in (e.g. its directory)"),
        sessionId: sessionIdSchema
      }
    },
    async ({ question, context, suggestion, agent, project, sessionId }, extra) => {
      const resolved = await resolveIdentity(sessionId)
      const { agent: effectiveAgent, project: effectiveProject } =
        effectiveIdentity(resolved, agent, project)
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
        "--permission-prompt-tool mcp__plugin_hmux_hmux__approve). Sends the requested tool use to " +
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
          .describe("The project you are working in (e.g. its directory)"),
        sessionId: sessionIdSchema
      }
    },
    async ({ tool_name, input, tool_use_id: _toolUseId, agent, project, sessionId }, extra) => {
      // Claude Code calls this tool itself with only tool_name/input/
      // tool_use_id — identity comes from the request headers.
      const resolved = await resolveIdentity(sessionId)
      const { agent: effectiveAgent, project: effectiveProject } =
        effectiveIdentity(resolved, agent, project)
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
          .describe("The project you are working in (e.g. its directory)"),
        sessionId: sessionIdSchema
      }
    },
    async ({ message, agent, project, sessionId }) => {
      const resolved = await resolveIdentity(sessionId)
      const { agent: effectiveAgent, project: effectiveProject } =
        effectiveIdentity(resolved, agent, project)
      const record: Message = {
        id: crypto.randomUUID(),
        kind: "notify",
        agent: effectiveAgent ?? randomId("agent"),
        ...(effectiveProject !== undefined ? { project: effectiveProject } : {}),
        body: message,
        status: "pending",
        createdAt: Date.now()
      }
      await run(Effect.flatMap(Hub, (hub) => hub.publishNew(record)))
      return { content: [{ type: "text", text: "Notification delivered to the human." }] }
    }
  )

  server.registerTool(
    "signal",
    {
      title: "Signal how your turn is ending",
      description:
        "Declare what state your turn ends in, so the human's dashboard can label it. Call " +
        "this just before ending your turn — it carries NO content; your chat response is " +
        "the content. Use status 'question' when your response asks the human something and " +
        "you need their answer to continue; use 'done' when the work is complete and nothing " +
        "is needed from the human. Returns immediately. (For a mid-task question that should " +
        "block while you wait, use the ask tool instead.)",
      inputSchema: {
        status: z
          .enum(["done", "question"])
          .describe(
            "'question' — your response asks for direction; 'done' — finished, nothing needed"
          ),
        sessionId: sessionIdSchema
      }
    },
    async ({ status, sessionId }) => {
      // The signal itself is delivered out-of-band: the Claude Code plugin's
      // PreToolUse hook sees this call and advertises the label into the hmux
      // plane at Stop. Server-side there is nothing to publish — no inbox
      // message, no blocking — so this handler is just an identity touch.
      await resolveIdentity(sessionId)
      return { content: [{ type: "text", text: `Turn signalled as '${status}'.` }] }
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
    agent: req.headers.get("x-hmux-agent") ?? undefined,
    project: req.headers.get("x-hmux-project") ?? undefined,
    session: req.headers.get("x-hmux-session") ?? undefined
  }
  const server = buildServer(run, identity)
  await server.connect(transport)
  return transport.handleRequest(req)
}
