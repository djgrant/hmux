/**
 * `hmux wait <target>` — block until the target window's agent settles
 * (status leaves busy), then print the final status and exit. Built for
 * orchestrators: arm it in a background shell after a send and be woken
 * when the reply is ready, keyed off the advertise plane's own status
 * semantics rather than anyone's transcript format.
 *
 * The send→pickup race: the sender arms the wait before the agent has
 * flipped busy, so a bare "exit when not busy" would return immediately.
 * The wait therefore settles on a busy→settled transition, or — when no
 * busy is ever observed — only after a grace period, which covers both
 * "the agent finished inside one poll interval" and "it never started".
 */

export interface WaitOptions {
  /** Give up after this long. 0 (default) waits forever. */
  timeoutMs?: number
  /** How long a never-busy target must stay settled before we believe it. */
  graceMs?: number
  pollMs?: number
}

export type WaitResult =
  | { outcome: "settled"; status: string | null }
  | { outcome: "timeout" }
  | { outcome: "gone" }

/**
 * Poll until settled. `poll` returns the target's advertised status
 * (null when the agent advertised nothing) or undefined when the target
 * no longer exists.
 */
export async function waitForSettle(
  poll: () => Promise<string | null | undefined>,
  { timeoutMs = 0, graceMs = 5000, pollMs = 500 }: WaitOptions = {},
): Promise<WaitResult> {
  const started = Date.now()
  let seenBusy = false
  while (true) {
    const status = await poll()
    if (status === undefined) return { outcome: "gone" }
    if (status === "busy") seenBusy = true
    else if (seenBusy || Date.now() - started >= graceMs) return { outcome: "settled", status }
    if (timeoutMs > 0 && Date.now() - started >= timeoutMs) return { outcome: "timeout" }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/** Parse `hmux wait` argv (after the subcommand). Null on bad usage. */
export function parseWaitArgs(argv: string[]): { target: string; timeoutMs: number } | null {
  const [target, ...rest] = argv
  if (!target || target.startsWith("--")) return null
  let timeoutMs = 0
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] !== "--timeout" || rest[i + 1] === undefined) return null
    const seconds = Number(rest[i + 1])
    if (!Number.isFinite(seconds) || seconds <= 0) return null
    timeoutMs = seconds * 1000
  }
  return { target, timeoutMs }
}
