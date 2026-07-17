/**
 * The write path of the advertise protocol: `hmux advertise` (see cli.ts).
 * Advertisers call hmux; hmux stores the state in the current backend's
 * transport. For the tmux backend that is pane user options on the caller's
 * own pane ($TMUX_PANE), so the state needs no registration and dies with
 * the pane.
 *
 * Field semantics: a string sets, null unsets, undefined leaves untouched.
 * status and detail travel as one unit (detail annotates status); agent,
 * resume and transcript persist until explicitly changed.
 */

export interface AdvertiseFields {
  /** message | busy | error | idle — see README for what each renders as. */
  status?: string | null
  /** One-line human-readable context for the status. */
  detail?: string | null
  /** Identity of the agent in the pane (e.g. "api-3f2c · sonnet"). */
  agent?: string | null
  /** Command that brings the pane's occupant back after a restore. */
  resume?: string | null
  /** Path to the occupant's conversation transcript (e.g. a cc session jsonl). */
  transcript?: string | null
}

const OPTIONS: Record<keyof AdvertiseFields, string> = {
  status: "@hmux_status",
  detail: "@hmux_detail",
  agent: "@hmux_agent",
  resume: "@hmux_resume",
  transcript: "@hmux_transcript",
}

/**
 * Liveness anchor for the advertised state, written alongside every
 * advertise. The read side (tmux.ts list()) treats status/detail/agent as
 * stale once this pid is dead, so a killed or crashed agent — whose
 * SessionEnd clear never ran — cannot leave a ghost status on a pane that
 * now holds a bare shell.
 */
const PID_OPTION = "@hmux_pid"

function parentOf(pid: number): number | null {
  const out = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  })
    .stdout.toString()
    .trim()
  const ppid = Number(out)
  return Number.isFinite(ppid) && ppid > 0 && ppid !== pid ? ppid : null
}

/**
 * The pid whose life the advertised state should be bound to, or null when
 * this process does not actually run inside the given pane. TMUX_PANE alone
 * is not proof of occupancy: a GUI app launched from a tmux shell (e.g. Zed)
 * inherits the variable into its whole process tree, and a caller in its
 * integrated terminal would stamp status onto a pane it does not occupy.
 * Genuinely inside means the pane's root process is an ancestor of ours —
 * that holds for harness hooks (often spawned with no controlling tty of
 * their own) and rejects inherited env, since a GUI app's ancestry runs to
 * init, never through the pane root.
 *
 * The occupant is the ancestor directly under the pane root — the agent
 * process whose hooks are speaking (a hook's chain runs hook → agent →
 * shell). When the caller itself sits directly under the root (a one-shot
 * `hmux advertise` typed at the prompt), it is about to exit, so the state
 * binds to the pane root and keeps the old lives-with-the-pane semantics.
 */
function occupantPid(pane: string): number | null {
  try {
    const paneRoot = Number(
      Bun.spawnSync(["tmux", "display-message", "-p", "-t", pane, "#{pane_pid}"], {
        stdout: "pipe",
        stderr: "ignore",
      })
        .stdout.toString()
        .trim(),
    )
    if (!Number.isFinite(paneRoot) || paneRoot <= 1) return null
    if (process.pid === paneRoot) return paneRoot
    let pid = process.pid
    for (let depth = 0; depth < 50; depth++) {
      const ppid = parentOf(pid)
      if (ppid === null) return null
      if (ppid === paneRoot) return pid === process.pid ? paneRoot : pid
      if (ppid === 1) return null
      pid = ppid
    }
    return null
  } catch {
    return null
  }
}

/** Write the given fields onto the calling pane. No-op outside a pane. */
export function advertise(fields: AdvertiseFields): void {
  const pane = process.env.TMUX_PANE
  if (!pane) return
  const occupant = occupantPid(pane)
  if (occupant === null) return
  const setsAny = Object.values(fields).some((v) => typeof v === "string")
  const writes: string[][] = []
  for (const [field, option] of Object.entries(OPTIONS) as [keyof AdvertiseFields, string][]) {
    const value = fields[field]
    if (value === undefined) continue
    writes.push(
      value === null
        ? ["set-option", "-pu", "-t", pane, option]
        : ["set-option", "-p", "-t", pane, option, value],
    )
  }
  writes.push(
    setsAny
      ? ["set-option", "-p", "-t", pane, PID_OPTION, String(occupant)]
      : ["set-option", "-pu", "-t", pane, PID_OPTION],
  )
  for (const args of writes) {
    try {
      Bun.spawnSync(["tmux", ...args], { stdout: "ignore", stderr: "ignore" })
    } catch {}
  }
}

/**
 * Parse `hmux advertise` argv (everything after the subcommand). Returns the
 * fields to write, or null on bad usage. `--clear` unsets every field; a
 * `--status` without `--detail` clears the detail, so a stale annotation
 * cannot outlive the status it described.
 */
export function parseAdvertiseArgs(argv: string[]): AdvertiseFields | null {
  if (argv[0] === "--clear" && argv.length === 1)
    return { status: null, detail: null, agent: null, resume: null, transcript: null }
  const fields: AdvertiseFields = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined) return null
    if (flag === "--status") fields.status = value
    else if (flag === "--detail") fields.detail = value
    else if (flag === "--agent") fields.agent = value
    else if (flag === "--resume") fields.resume = value
    else if (flag === "--transcript") fields.transcript = value
    else return null
  }
  if (Object.keys(fields).length === 0) return null
  if (fields.status !== undefined && fields.detail === undefined) fields.detail = null
  return fields
}
