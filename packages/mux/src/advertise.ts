/**
 * The write path of the advertise protocol: `mux advertise` (see cli.ts).
 * Advertisers call mux; mux stores the state in the current backend's
 * transport. For the tmux backend that is pane user options on the caller's
 * own pane ($TMUX_PANE), so the state needs no registration and dies with
 * the pane.
 *
 * Field semantics: a string sets, null unsets, undefined leaves untouched.
 * status and detail travel as one unit (detail annotates status); agent and
 * resume persist until explicitly changed.
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
}

const OPTIONS: Record<keyof AdvertiseFields, string> = {
  status: "@mux_status",
  detail: "@mux_detail",
  agent: "@mux_agent",
  resume: "@mux_resume",
}

/** Write the given fields onto the calling pane. No-op outside a pane. */
export function advertise(fields: AdvertiseFields): void {
  const pane = process.env.TMUX_PANE
  if (!pane) return
  for (const [field, option] of Object.entries(OPTIONS) as [keyof AdvertiseFields, string][]) {
    const value = fields[field]
    if (value === undefined) continue
    const args =
      value === null
        ? ["set-option", "-pu", "-t", pane, option]
        : ["set-option", "-p", "-t", pane, option, value]
    try {
      Bun.spawnSync(["tmux", ...args], { stdout: "ignore", stderr: "ignore" })
    } catch {}
  }
}

/**
 * Parse `mux advertise` argv (everything after the subcommand). Returns the
 * fields to write, or null on bad usage. `--clear` unsets every field; a
 * `--status` without `--detail` clears the detail, so a stale annotation
 * cannot outlive the status it described.
 */
export function parseAdvertiseArgs(argv: string[]): AdvertiseFields | null {
  if (argv[0] === "--clear" && argv.length === 1)
    return { status: null, detail: null, agent: null, resume: null }
  const fields: AdvertiseFields = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined) return null
    if (flag === "--status") fields.status = value
    else if (flag === "--detail") fields.detail = value
    else if (flag === "--agent") fields.agent = value
    else if (flag === "--resume") fields.resume = value
    else return null
  }
  if (Object.keys(fields).length === 0) return null
  if (fields.status !== undefined && fields.detail === undefined) fields.detail = null
  return fields
}
