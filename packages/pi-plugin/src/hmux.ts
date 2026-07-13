/**
 * The hmux client surface used by the pi extension. It mirrors what the Claude
 * Code plugin's hook does, but for pi's world:
 *
 *   - Session lifecycle over the server's plain-JSON REST endpoints
 *     (register / status / end / get) — identical wire contract to the CC hook.
 *   - The `hmux advertise` CLI for the signal plane (tmux pane user options),
 *     independent of the hmux server.
 *   - The blocking ask / notify tools over the server's MCP endpoint. pi has no
 *     built-in MCP, so instead of declaring an MCP server (as the CC plugin's
 *     .mcp.json does) the extension speaks MCP as a *client* to reuse the exact
 *     same ask/notify/signal handlers the CC path uses.
 *
 * Every network path is failure-silent and short-timeout: an hmux that is down
 * or slow must never disturb a pi session.
 */

import { spawnSync } from "node:child_process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const BASE = process.env.HMUX_URL ?? "http://localhost:7373"
const FETCH_TIMEOUT_MS = 2000
// A blocked ask has no timeout on the server; keep the client patient too and
// let the server's ~20s progress notifications reset the idle clock.
const ASK_TIMEOUT_MS = 24 * 60 * 60 * 1000

export interface SessionInfo {
  bound?: boolean
  agent?: string
  project?: string
}

/** hmux status vocabulary carried on the signal plane. */
export type AdvertiseStatus = "idle" | "busy" | "message" | "error"

const request = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })

const post = (path: string, body?: unknown): Promise<Response> =>
  request(path, {
    method: "POST",
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {})
  })

/** Register (or refresh) this session with the hmux server. Failure-silent. */
export const registerSession = async (opts: {
  id: string
  agent?: string
  project?: string
  model?: string
}): Promise<void> => {
  try {
    await post("/sessions/register", {
      id: opts.id,
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      ...(opts.project !== undefined ? { project: opts.project } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {})
    })
  } catch {}
}

/** Push a server-side status. Server statuses: working | idle | needs-attention. */
export const setStatus = async (
  id: string,
  status: "working" | "idle" | "needs-attention",
  detail?: string
): Promise<void> => {
  try {
    await post(`/sessions/${encodeURIComponent(id)}/status`, {
      status,
      ...(detail !== undefined ? { detail } : {})
    })
  } catch {}
}

/** End the session on the server. Failure-silent. */
export const endSession = async (id: string): Promise<void> => {
  try {
    await post(`/sessions/${encodeURIComponent(id)}/end`)
  } catch {}
}

/** GET the session, or undefined on any failure (server down, 404, bad JSON). */
export const getSessionInfo = async (id: string): Promise<SessionInfo | undefined> => {
  try {
    const res = await request(`/sessions/${encodeURIComponent(id)}`)
    if (!res.ok) return undefined
    return (await res.json()) as SessionInfo
  } catch {
    return undefined
  }
}

/**
 * Advertise onto the calling pane via `hmux advertise`. The extension runs
 * inside the pane, so hmux knows exactly which pane is speaking. `status: null`
 * clears the status; fields left undefined are untouched. Failure-silent,
 * including when hmux is not installed.
 */
export const advertise = (fields: {
  status?: AdvertiseStatus | null
  detail?: string
  agent?: string
  resume?: string
  transcript?: string
}): void => {
  const args =
    fields.status === null
      ? ["--clear"]
      : [
          ...(fields.status !== undefined ? ["--status", fields.status] : []),
          ...(fields.detail !== undefined ? ["--detail", fields.detail] : []),
          ...(fields.agent !== undefined ? ["--agent", fields.agent] : []),
          ...(fields.resume !== undefined ? ["--resume", fields.resume] : []),
          ...(fields.transcript !== undefined ? ["--transcript", fields.transcript] : [])
        ]
  try {
    spawnSync("hmux", ["advertise", ...args], { stdio: "ignore" })
  } catch {}
}

/**
 * Call an hmux MCP tool (ask / notify) as a client and return its text result.
 * A fresh client+transport per call keeps the state model dead simple and
 * matches the server's stateless streamable-HTTP transport. `sessionId` is
 * passed in the tool args: the server treats a registered session as
 * authoritative for agent/project, so identity is harness-asserted, not
 * model-asserted — the same guarantee the CC hook's PreToolUse stamp gives.
 *
 * Throws on transport failure so the caller can surface a tool error; the ask
 * itself has no timeout (the server blocks until the human answers).
 */
export const callHmuxTool = async (
  name: "ask" | "notify",
  args: Record<string, unknown>,
  sessionId: string
): Promise<string> => {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`))
  const client = new Client({ name: "hmux-pi-plugin", version: "0.0.0" })
  try {
    await client.connect(transport)
    const result = await client.callTool(
      { name, arguments: { ...args, sessionId } },
      undefined,
      // ask blocks indefinitely; the server's progress pings reset this clock.
      { timeout: ASK_TIMEOUT_MS, resetTimeoutOnProgress: true }
    )
    const content = Array.isArray(result.content) ? result.content : []
    const text = content
      .filter((c): c is { type: "text"; text: string } => c?.type === "text")
      .map((c) => c.text)
      .join("\n")
    return text
  } finally {
    await client.close().catch(() => {})
  }
}
