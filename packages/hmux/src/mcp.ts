/**
 * `hmux mcp` — the chief-of-staff surface over the control layer, an MCP
 * server on stdio (see cli.ts for dispatch). The picker shows Daniel the
 * map; this surface exists for an agent to go further: read each session's
 * conversation and act on Daniel's behalf.
 *
 * The division of labour with the backend seam: discovery and actuation go
 * through Backend (list/send/open/create); reading goes through advertised
 * transcript paths (transcript.ts) — hmux still never interprets what runs
 * inside a pane, it follows the pointer the pane advertised. There is
 * deliberately no kill, no advertise write path, and no capture-pane
 * fallback: a pane that advertised nothing stays opaque.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { findWindow, type Backend } from "./backend"
import { readTranscript, transcriptFromResume } from "./transcript"

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] })
const json = (value: unknown) => text(JSON.stringify(value, null, 2))

export function buildServer(backend: Backend): McpServer {
  const server = new McpServer({ name: "hmux", version: "0.0.0" })

  server.registerTool(
    "list",
    {
      title: "List sessions and windows",
      description:
        "The map of the user's terminal sessions: every session and window, its directory, " +
        "which agent runs there, and the state that agent advertised. Status priority: " +
        "error > message (the agent left the human something; detail says what) > busy > " +
        "idle. A null status means no agent advertised anything — a plain pane. " +
        "hasTranscript tells you whether read will work on that window. Each window " +
        "lists its panes: a window can hold several (e.g. an agent beside a dev server), " +
        "each with its own dir, agent, and advertised state.",
      inputSchema: {},
    },
    async () => {
      const groups = await backend.list()
      return json(
        groups.map((g) => ({
          target: g.target,
          name: g.name,
          dir: g.dir,
          status: g.status,
          detail: g.detail,
          windows: g.windows.map((w) => ({
            target: w.target,
            name: w.name,
            dir: w.dir,
            agent: w.agent,
            status: w.status,
            detail: w.detail,
            hasTranscript: w.transcript !== null,
            panes: w.panes.map((p) => ({
              paneId: p.paneId,
              dir: p.dir,
              agent: p.agent,
              active: p.active,
              status: p.status,
              detail: p.detail,
              hasTranscript: p.transcript !== null,
            })),
          })),
        })),
      )
    },
  )

  server.registerTool(
    "read",
    {
      title: "Read a session's conversation",
      description:
        "Read the recent conversation of the agent running in a window — the actual " +
        "transcript, not the terminal screen. Use the window target from list. Tool " +
        "results are elided by default; set includeToolResults for the full exchange. " +
        "A window whose agent advertised no transcript is opaque: the user can open it " +
        "themselves, but you cannot read it.",
      inputSchema: {
        target: z.string().describe("Window target from list, e.g. 'api:1' (a bare session name reads its first window)"),
        turns: z.number().int().positive().optional().describe("How many trailing turns (default 20)"),
        includeToolResults: z.boolean().optional().describe("Include tool result content (verbose)"),
      },
    },
    async ({ target, turns, includeToolResults }) => {
      const window = findWindow(await backend.list(), target)
      if (!window) return text(`No window matches '${target}' — check list.`)
      const path = window.transcript ?? (await resumePath(window.paneId))
      if (!path)
        return text(
          `'${target}' advertised no transcript — it is opaque to read. ` +
            "The user can look at it directly via open.",
        )
      try {
        const conversation = await readTranscript(path, { turns, includeToolResults })
        return json({ target, agent: window.agent, transcript: path, turns: conversation })
      } catch {
        return text(`Transcript at ${path} could not be read (moved or deleted?).`)
      }
    },
  )

  server.registerTool(
    "send",
    {
      title: "Send a message to a session's agent",
      description:
        "Paste a message into the agent's prompt and submit it — the session receives it " +
        "exactly as if the user had typed it there, and the agent will act on it with the " +
        "user's authority. Only send what the user has explicitly asked you to dispatch. " +
        "The reply lands in that session; read it with read after giving the agent time " +
        "to respond.",
      inputSchema: {
        target: z.string().describe("Window target from list, e.g. 'api:1'"),
        message: z.string().describe("The message to type into the agent's prompt"),
      },
    },
    async ({ target, message }) => {
      const window = findWindow(await backend.list(), target)
      if (!window) return text(`No window matches '${target}' — check list.`)
      await backend.send(window.paneId, message)
      return text(
        `Sent to ${target} (${window.agent ?? "no advertised agent"}). ` +
          `If you need its reply, \`hmux wait ${target}\` in a background shell exits ` +
          "when the agent settles; then read.",
      )
    },
  )

  server.registerTool(
    "open",
    {
      title: "Show a session to the user",
      description:
        "Load a session or window into the user's parked display target and focus it — " +
        "use when the user wants to look at something themselves. Needs a terminal parked " +
        "with `hmux target`; reports back when none is.",
      inputSchema: {
        target: z.string().describe("Session or window target from list"),
      },
    },
    async ({ target }) => {
      const [client] = await backend.targets()
      if (!client)
        return text("No display target is parked — the user runs `hmux target` in a spare terminal first.")
      await backend.openInClient(target, client)
      return text(`Opened ${target} in the display target.`)
    },
  )

  server.registerTool(
    "create",
    {
      title: "Create a session or window",
      description:
        "Create a new session, or — with a slash ('session/window') — a window inside a " +
        "session, creating the session if it is new. Returns the target. Creation never " +
        "drops the user in: the session is born detached and stays in the background — " +
        "call open only when the user asks to look at it. Pass dir to set the working " +
        "directory and command to launch something there (e.g. 'claude'), so a single " +
        "create yields a ready-to-work session; otherwise dispatch work as create then send.",
      inputSchema: {
        name: z.string().describe("Session name, or 'session/window'"),
        dir: z.string().optional().describe("Working directory for the new session (defaults to HOME)"),
        command: z.string().optional().describe("Command to run in the new pane, e.g. 'claude' to launch an agent"),
      },
    },
    async ({ name, dir, command }) => {
      const target = await backend.create(name, { dir, command })
      return text(target)
    },
  )

  return server
}

/** Resume-command fallback for sessions advertised before --transcript existed. */
async function resumePath(paneId: string): Promise<string | null> {
  // The resume command lives on the agent's pane as @hmux_resume — address
  // the pane id, not the window, so a multi-pane window still resolves.
  // Import lazily to keep this module testable against a fake backend.
  const { tmux } = await import("./tmux")
  const resume = await tmux(["display-message", "-p", "-t", paneId, "#{@hmux_resume}"]).catch(() => "")
  if (!resume.trim()) return null
  return transcriptFromResume(resume.trim())
}

/** Entry point for `hmux mcp`: serve on stdio until the client disconnects. */
export async function serve(backend?: Backend): Promise<void> {
  if (!backend) {
    const { TmuxBackend } = await import("./tmux")
    backend = new TmuxBackend(false)
  }
  await backend.ensure()
  const server = buildServer(backend)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((resolve) => transport.onclose = resolve)
}
