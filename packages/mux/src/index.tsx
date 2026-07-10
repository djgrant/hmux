import { render } from "@opentui/solid"
import { App } from "./App"
import { MAIN_BG } from "./theme"
import { TmuxBackend } from "./tmux"
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

const backend = new TmuxBackend()
setBackend(backend)

// `mux <name>` jumps straight into the best-matching session; the router
// appears when the user detaches (prefix d).
const arg = process.argv[2]
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
