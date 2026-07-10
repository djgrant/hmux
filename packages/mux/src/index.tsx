import { render } from "@opentui/solid"
import { App } from "./App"
import { MAIN_BG } from "./theme"
import { TmuxBackend, insideTmux } from "./tmux"
import { fuzzyScore, setBackend } from "./store"

// Full-screen TUI sizes itself from STDOUT; refuse to render clamped into a
// corner when stdout is a pipe (same guard as @humans/tui, round 21).
if (!process.stdout.isTTY) {
  console.error(
    "mux: stdout is not a terminal — refusing to render a clamped UI.\n" +
      "Run directly in a terminal pane (not through a log-piping dev runner).",
  )
  process.exit(1)
}

const inTmux = await insideTmux()
const backend = new TmuxBackend(inTmux)
setBackend(backend)

const arg = process.argv[2]

// `mux target`: park this terminal as a display target. The picker (running
// anywhere else) routes opens into this terminal and stays on screen itself.
if (arg === "target") {
  if (inTmux) {
    console.error("mux target: run this in a terminal that is not already inside tmux.")
    process.exit(1)
  }
  const { registerTarget, unregisterTarget, HOLD_SESSION } = await import("./targets")
  const tty = Bun.spawnSync(["tty"], { stdin: "inherit" }).stdout.toString().trim()
  if (!tty || tty === "not a tty") {
    console.error("mux target: cannot determine this terminal's tty.")
    process.exit(1)
  }
  // One target at a time: routing is "the target", not "a target", so a
  // second registration must either evict the first or back off.
  const existing = (await backend.targets()).filter((t) => t.tty !== tty)
  if (existing.length > 0) {
    process.stdout.write(
      `mux target: ${existing[0].tty} is already the target. [k]ill it and take over, or [a]bort? `,
    )
    const answer = await new Promise<string>((resolve) => {
      process.stdin.setRawMode?.(true)
      process.stdin.resume()
      process.stdin.once("data", (d) => {
        process.stdin.setRawMode?.(false)
        process.stdin.pause()
        resolve(d.toString())
      })
    })
    process.stdout.write("\n")
    if (answer.toLowerCase() !== "k") {
      console.error("mux target: aborted — existing target kept.")
      process.exit(1)
    }
    // Detaching the old client ends its `mux target` process (its attach
    // returns), which unregisters it in its own finally.
    for (const t of existing) {
      Bun.spawnSync(["tmux", "detach-client", "-t", t.tty])
      unregisterTarget(t.tty)
    }
  }
  // The hold session gives this client somewhere to sit until the picker
  // sends a real session over. Recreated on demand; hidden from the picker.
  Bun.spawnSync([
    "tmux", "new-session", "-d", "-s", HOLD_SESSION,
    "printf '\\n  mux target — pick a session in mux to load it here\\n'; exec cat",
  ])
  registerTarget(tty, process.env.TERM_PROGRAM ?? null)
  try {
    const proc = Bun.spawn(["tmux", "attach", "-t", HOLD_SESSION], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    await proc.exited
  } finally {
    unregisterTarget(tty)
  }
  process.exit(0)
}

// `mux <name>` jumps straight into the best-matching session; the router
// appears when the user detaches (prefix d).
if (arg) {
  const groups = await backend.list()
  const best = groups
    .map((g) => ({ g, score: fuzzyScore(g.name, arg) }))
    .filter((s) => s.score >= 0)
    .sort((a, b) => b.score - a.score)[0]
  if (best) await backend.open(best.g.target)
  else console.error(`mux: no session matching "${arg}"`)
}

render(() => <App backend={backend} />, { backgroundColor: MAIN_BG })
