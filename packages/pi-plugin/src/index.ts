/**
 * hmux pi extension. The pi-harness counterpart to the hmux Claude Code plugin:
 * it gives a pi session live presence on a local hmux server and wires up the
 * human-in-the-loop tools, using pi's extension event model in place of Claude
 * Code's hooks.
 *
 * Event mapping (pi event -> what the CC hook did on the matching Claude event):
 *
 *   session_start     -> SessionStart:  register the session, advertise it at
 *                        rest (idle), publish a resume command and the session
 *                        transcript path onto the signal plane.
 *   before_agent_start-> UserPromptSubmit: turn the pane busy, mark the server
 *                        session "working", and inject the bound-session context
 *                        once when the human has bound this session.
 *   tool_execution_end-> PostToolUse (heartbeat): every tool use bumps the pane
 *                        to busy and refreshes last_seen, and picks up a
 *                        mid-task bind.
 *   agent_settled     -> Stop: promote a declared turn-end signal (question ->
 *                        needs-attention, done -> idle "done"); otherwise rest
 *                        at idle.
 *   session_shutdown  -> SessionEnd: end the server session and clear the pane.
 *
 * pi has no built-in MCP, so the ask / notify / signal tools the CC plugin
 * declared via .mcp.json are instead registered natively here and proxied to
 * the hmux server (see hmux.ts). Because these are our own tools, they know the
 * pi session id directly — no PreToolUse identity stamp is needed.
 *
 * There is no `approve` tool: it exists in the CC plugin only to serve Claude
 * Code's headless --permission-prompt-tool contract, which pi does not have.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { execFileSync } from "node:child_process"
import { basename } from "node:path"
import {
  advertise,
  callHmuxTool,
  endSession,
  getSessionInfo,
  registerSession,
  setStatus,
  type SessionInfo
} from "./hmux.js"

const boundContext =
  "This session is bound to a human inbox via hmux. When you need a decision, " +
  "clarification, or approval, ask the human with the hmux_ask tool instead of " +
  "guessing. Send progress updates and completions with hmux_notify. Just before " +
  "ending a turn, declare how it ends with hmux_signal: status 'question' when your " +
  "response asks the human something, 'done' when the work is complete."

/** Current git branch of cwd, or undefined outside a repo / on any failure. */
const gitBranch = (cwd: string): string | undefined => {
  try {
    const out = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .trim()
    return out.length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

export default function (pi: ExtensionAPI) {
  // Per-session extension state. pi reloads and rebinds the extension on session
  // switch/fork, so module-scoped state is scoped to one session's lifetime.
  let sessionId: string | undefined
  // A declared turn-end signal (from hmux_signal), promoted at agent_settled.
  let declaredSignal: "done" | "question" | undefined
  // Whether the bound-session context has already been injected this session.
  let injectedBound = false

  const currentId = (ctx: ExtensionContext): string =>
    (sessionId = ctx.sessionManager.getSessionId())

  pi.on("session_start", async (_event, ctx) => {
    const id = currentId(ctx)
    // Fresh conversation state: whatever an earlier run injected is gone, and no
    // turn-end signal is pending yet.
    injectedBound = false
    declaredSignal = undefined

    const cwd = ctx.cwd
    const dir = basename(cwd) || "pi"
    const branch = gitBranch(cwd)
    const model = ctx.model?.id
    const agentName = `${dir}${branch !== undefined ? `/${branch}` : ""}-${id.slice(0, 4)}`

    advertise({
      status: "idle",
      agent: [`${dir}-${id.slice(0, 4)}`, model].filter(Boolean).join(" · "),
      resume: `pi --session ${id}`,
      // pi persists its conversation to a session file; hand hmux the path so
      // its transcript surface can read this session.
      ...(ctx.sessionManager.getSessionFile() !== undefined
        ? { transcript: ctx.sessionManager.getSessionFile() }
        : {})
    })
    await registerSession({
      id,
      agent: agentName,
      project: cwd,
      ...(model !== undefined ? { model } : {})
    })
  })

  pi.on("before_agent_start", async (_event, ctx) => {
    const id = currentId(ctx)
    // The human has taken a turn; a previously declared turn-end label is spent.
    declaredSignal = undefined
    advertise({ status: "busy" })
    await setStatus(id, "working")

    const session = await getSessionInfo(id)
    if (session?.bound === true) {
      if (injectedBound) return
      injectedBound = true
      // Persistent message: stored in the session and sent to the LLM, the pi
      // analogue of the CC hook's additionalContext.
      return {
        message: {
          customType: "hmux-bound",
          content: boundContext,
          display: false
        }
      }
    }
    // Unbound (or unknown): let a later bind re-inject.
    injectedBound = false
    return
  })

  // Heartbeat + mid-task bind pickup. Every tool call proves the agent is alive
  // and working; if the human bound this session mid-turn, inject the context
  // once here rather than waiting for the next prompt.
  pi.on("tool_execution_end", async (_event, ctx) => {
    const id = currentId(ctx)
    advertise({ status: "busy" })
    await setStatus(id, "working")

    const session = await getSessionInfo(id)
    if (session?.bound !== true) {
      injectedBound = false
      return
    }
    if (injectedBound) return
    injectedBound = true
    pi.sendMessage(
      { customType: "hmux-bound", content: boundContext, display: false },
      { deliverAs: "steer" }
    )
  })

  // Stop equivalent: a declared signal ends the turn as an attention state; an
  // unsignalled settle honestly rests at idle rather than faking urgency.
  pi.on("agent_settled", async (_event, ctx) => {
    const id = currentId(ctx)
    if (declaredSignal === "question") {
      advertise({ status: "message", detail: "needs direction" })
      await setStatus(id, "needs-attention", "asked a question — see chat")
    } else if (declaredSignal === "done") {
      advertise({ status: "message", detail: "done" })
      await setStatus(id, "idle")
    } else {
      advertise({ status: "idle" })
      await setStatus(id, "idle")
    }
    declaredSignal = undefined
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId()
    advertise({ status: null, agent: undefined })
    await endSession(id)
  })

  // --- Human-in-the-loop tools (proxied to the hmux server) ------------------

  pi.registerTool({
    name: "hmux_ask",
    label: "Ask the human",
    description:
      "Ask the human operator a question and wait for their reply. Use this whenever you " +
      "need a decision, clarification, credentials, or approval. This call BLOCKS until the " +
      "human answers (there is no timeout), and the tool result is the human's answer text.",
    promptGuidelines: [
      "Use hmux_ask when you need a decision, clarification, or approval from the human, " +
        "rather than guessing."
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask the human" }),
      context: Type.Optional(
        Type.String({ description: "Optional extra context to help the human answer" })
      ),
      suggestion: Type.Optional(
        Type.String({
          description:
            "A short suggested answer the human can accept with one key, e.g. 'ok' or 'yes, proceed'"
        })
      )
    }),
    async execute(_toolCallId, params) {
      const id = sessionId ?? ""
      // Surface the pending question on the signal plane for the duration of
      // the block; the next tool use / settle returns the pane to its state.
      advertise({
        status: "message",
        detail: params.question ? `asks: ${params.question.trim().slice(0, 120)}` : "needs decision"
      })
      try {
        const answer = await callHmuxTool("ask", params, id)
        return { content: [{ type: "text", text: answer }], details: {} }
      } finally {
        advertise({ status: "busy" })
      }
    }
  })

  pi.registerTool({
    name: "hmux_notify",
    label: "Notify the human",
    description:
      "Send the human operator an FYI notification (progress updates, completions, warnings). " +
      "No reply is expected; this returns immediately.",
    parameters: Type.Object({
      message: Type.String({ description: "The notification text" })
    }),
    async execute(_toolCallId, params) {
      const id = sessionId ?? ""
      const text = await callHmuxTool("notify", params, id)
      return { content: [{ type: "text", text }], details: {} }
    }
  })

  pi.registerTool({
    name: "hmux_signal",
    label: "Signal turn end",
    description:
      "Declare what state your turn ends in, so the human's dashboard can label it. Call this " +
      "just before ending your turn — it carries NO content; your chat response is the content. " +
      "Use status 'question' when your response asks the human something; use 'done' when the " +
      "work is complete and nothing is needed from the human.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("done"), Type.Literal("question")], {
        description:
          "'question' — your response asks for direction; 'done' — finished, nothing needed"
      })
    }),
    async execute(_toolCallId, params) {
      // Delivered out-of-band, exactly like the CC path: stash the declaration
      // for agent_settled to promote. Nothing is published to the server here.
      declaredSignal = params.status
      return {
        content: [{ type: "text", text: `Turn signalled as '${params.status}'.` }],
        details: {}
      }
    }
  })
}
