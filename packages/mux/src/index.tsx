import { render } from "@opentui/solid"
import { App } from "./App"
import { MAIN_BG } from "./theme"

// Full-screen TUI sizes itself from STDOUT; refuse to render clamped into a
// corner when stdout is a pipe (same guard as @humans/tui, round 21).
if (!process.stdout.isTTY) {
  console.error(
    "mux: stdout is not a terminal — refusing to render a clamped UI.\n" +
      "Run directly in a terminal pane (not through a log-piping dev runner).",
  )
  process.exit(1)
}

render(() => <App />, { backgroundColor: MAIN_BG })
