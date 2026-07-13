/**
 * Reader for advertised conversation transcripts. This is the MCP surface's
 * read path: the CoS agent reads what a session's agent and human actually
 * said, rather than scraping the pane it renders in. Pure functions; the
 * caller supplies the path (advertised as @hmux_transcript, or derived from
 * @hmux_resume).
 *
 * Two harness schemas are understood, auto-detected per line so a single
 * reader serves either:
 *
 *   Claude Code — entry.type is "user" | "assistant"; message.content blocks
 *     are text | thinking | tool_use (name) | tool_result (nested content).
 *   pi          — entry.type is "message"; role lives in message.role
 *     (user | assistant | toolResult | …); assistant tool calls are "toolCall"
 *     blocks (name), and a tool result is its OWN entry (role "toolResult",
 *     message.toolName), not a block nested in a user turn.
 *
 * Both carry an ISO `timestamp` at the entry level and text as { type:"text",
 * text } blocks, so those paths are shared.
 */

export interface TranscriptTurn {
  role: "user" | "assistant"
  /** Concatenated text blocks (thinking excluded). */
  text: string
  /** Names of tools invoked in this turn (assistant) or resolved (user tool_result). */
  tools: string[]
  timestamp: string | null
}

export interface ReadOptions {
  /** How many trailing turns to keep. */
  turns?: number
  /**
   * Include tool_result content. Off by default: results dominate the byte
   * count and the CoS usually wants the conversation, not the file dumps.
   */
  includeToolResults?: boolean
}

interface ContentBlock {
  type?: string
  text?: string
  name?: string
  content?: unknown
}

/** One jsonl line, narrowed to what we read. */
interface Entry {
  type?: string
  timestamp?: string
  message?: {
    role?: string
    content?: string | ContentBlock[]
    /** pi toolResult entries name the resolved tool at the message level. */
    toolName?: string
  }
}

function blockText(block: ContentBlock, includeToolResults: boolean): string {
  if (block.type === "text" && typeof block.text === "string") return block.text
  if (block.type === "tool_result" && includeToolResults) {
    if (typeof block.content === "string") return block.content
    if (Array.isArray(block.content))
      return (block.content as ContentBlock[])
        .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
        .filter(Boolean)
        .join("\n")
  }
  return ""
}

function toTurn(entry: Entry, includeToolResults: boolean): TranscriptTurn | null {
  const message = entry.message
  // Conversational entries only: CC "user"/"assistant" or pi "message". Both
  // put the role on message.role; every other entry type (mode changes,
  // snapshots, model_change, custom, branch/compaction summaries) is plumbing.
  if (!message) return null
  if (entry.type !== "user" && entry.type !== "assistant" && entry.type !== "message") return null

  // pi tool results are standalone entries (role "toolResult"), the analogue
  // of CC's user turn that carries only a tool_result block. Elide by default;
  // when asked for, surface as a user turn labelled with the resolved tool.
  if (message.role === "toolResult") {
    if (!includeToolResults) return null
    const text = Array.isArray(message.content)
      ? message.content
          .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
          .filter(Boolean)
          .join("\n")
      : typeof message.content === "string"
        ? message.content
        : ""
    const tools = typeof message.toolName === "string" ? [message.toolName] : []
    if (text === "" && tools.length === 0) return null
    return { role: "user", text, tools, timestamp: entry.timestamp ?? null }
  }

  const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : null
  if (!role) return null

  const content = message.content
  if (typeof content === "string")
    return { role, text: content, tools: [], timestamp: entry.timestamp ?? null }
  if (!Array.isArray(content)) return null

  const text = content
    .map((b) => blockText(b, includeToolResults))
    .filter(Boolean)
    .join("\n")
  // Tool invocations: CC names them "tool_use", pi names them "toolCall".
  const tools = content
    .filter((b) => (b.type === "tool_use" || b.type === "toolCall") && typeof b.name === "string")
    .map((b) => b.name as string)
  const isToolResultOnly = content.every((b) => b.type === "tool_result" || b.type === "thinking")
  // A user entry that only carries tool results is harness plumbing, not the
  // human speaking — elide the whole turn unless results were asked for.
  if (!includeToolResults && isToolResultOnly && text === "" && tools.length === 0) return null
  return { role, text, tools, timestamp: entry.timestamp ?? null }
}

/**
 * Parse a transcript jsonl and return the last N conversational turns.
 * Malformed lines and non-conversational entry types (mode changes,
 * snapshots, attachments) are skipped, so a live file being appended to
 * mid-write still reads cleanly.
 */
export async function readTranscript(
  path: string,
  { turns = 20, includeToolResults = false }: ReadOptions = {},
): Promise<TranscriptTurn[]> {
  const raw = await Bun.file(path).text()
  const parsed: TranscriptTurn[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let entry: Entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const turn = toTurn(entry, includeToolResults)
    if (turn) parsed.push(turn)
  }
  return parsed.slice(-turns)
}

/**
 * Fallback for panes advertised before the transcript field existed: pull the
 * session id out of the resume command and find its jsonl. Both harnesses are
 * recognised:
 *
 *   claude --resume <id>  -> ~/.claude/projects/<project>/<id>.jsonl
 *   pi --session <id>     -> ~/.pi/agent/sessions/<project>/<ts>_<id>.jsonl
 *
 * Returns null when the resume carries no id or no file matches.
 */
export async function transcriptFromResume(resume: string): Promise<string | null> {
  const home = process.env.HOME

  const ccMatch = resume.match(/--resume\s+([\w-]+)/)
  if (ccMatch) {
    const glob = new Bun.Glob(`*/${ccMatch[1]}.jsonl`)
    for await (const file of glob.scan({ cwd: `${home}/.claude/projects`, absolute: true }))
      return file
  }

  // pi filenames are "<timestamp>_<uuid>.jsonl", so match the id as a suffix.
  const piMatch = resume.match(/--session\s+([\w-]+)/)
  if (piMatch) {
    const glob = new Bun.Glob(`*/*${piMatch[1]}.jsonl`)
    for await (const file of glob.scan({ cwd: `${home}/.pi/agent/sessions`, absolute: true }))
      return file
  }

  return null
}
