import { render } from "@opentui/solid"
import {
  DEFAULT_PORT,
  WS_PATH,
  isServerEvent,
  type ClientEvent,
} from "@hmux/protocol"
import { addMessage, applyInit, announceIncoming, loadDrafts, markAnswered, setConn, upsertSession } from "./store"
import { App } from "./App"
import { MAIN_BG } from "./theme"
import { applyTmuxNotificationOverride } from "./notify"
import { announcePresence } from "./presence"

// The TUI is full-screen and sizes itself from STDOUT: when stdout is a pipe
// (log-piping dev runners, `| tee`, CI), OpenTUI silently falls back to
// stdout.columns || 80 and never receives resize events — the UI renders
// clamped to a corner of the terminal and stays that way (round 21, live
// diagnosis: a dev runner spawned us with piped stdout while stdin was still
// the tty). Fail loudly instead of rendering a broken UI.
if (!process.stdout.isTTY) {
  console.error(
    "hmux mailbox: stdout is not a terminal — refusing to render a clamped UI.\n" +
      "Run the TUI directly in a terminal pane (not through a log-piping dev runner).",
  )
  process.exit(1)
}

// Inside tmux OpenTUI can't identify the outer terminal (TERM/TERM_PROGRAM
// read "tmux") and detects no notification protocol; detect it from surviving
// env fingerprints and force the protocol. Must run before render() creates
// the renderer, which snapshots the env. Requires `allow-passthrough on` in
// tmux ≥ 3.3 for the wrapped OSC to reach the outer terminal.
applyTmuxNotificationOverride()

// Record tty/program/pid so `open.ts` can focus this window instead of
// spawning another TUI.
announcePresence()

// Restore drafts persisted at ~/.hmux/drafts.json (HUMANS_DRAFTS_PATH to
// override) and enable the debounced write-behind.
loadDrafts()

// --- WebSocket client --------------------------------------------------------

const port = Number(process.env.HMUX_PORT) || DEFAULT_PORT
const url = `ws://localhost:${port}${WS_PATH}`

let ws: WebSocket | null = null
let attempts = 0
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let shuttingDown = false

function connect() {
  ws = new WebSocket(url)
  ws.onopen = () => {
    attempts = 0
    setConn("open")
  }
  ws.onmessage = (ev) => {
    let data: unknown
    try {
      data = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (!isServerEvent(data)) return
    if (data.type === "init") applyInit(data.messages, data.sessions)
    else if (data.type === "message.new") {
      addMessage(data.message)
      announceIncoming(data.message)
    } else if (data.type === "message.answered") {
      markAnswered(data.id, data.answer, data.answeredAt)
    } else if (data.type === "session.updated") {
      upsertSession(data.session)
    }
  }
  ws.onclose = () => {
    if (shuttingDown) return
    setConn("reconnecting")
    const delay = Math.min(1000 * 2 ** attempts, 15_000)
    attempts++
    reconnectTimer = setTimeout(connect, delay)
  }
  ws.onerror = () => {
    ws?.close()
  }
}

function sendAnswer(id: string, text: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  const event: ClientEvent = { type: "answer", id, text }
  ws.send(JSON.stringify(event))
  return true
}

function sendBind(sessionId: string, bound: boolean) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  const event: ClientEvent = { type: "bind", sessionId, bound }
  ws.send(JSON.stringify(event))
  return true
}

connect()
render(() => <App sendAnswer={sendAnswer} sendBind={sendBind} />, {
  // Precaution (round 20): OpenTUI's threaded backend (macOS default) has a
  // real race — out-of-band writeOut calls (terminal title, OS notification;
  // both fire on message arrival) write from the main thread after releasing
  // the render mutex, while the render thread flushes frames, and BOTH share
  // ONE 4096-byte staging buffer (renderer-output.zig StdoutOutput). A torn
  // flush there can drop/duplicate chunks. It was NOT the round-20 smearing
  // bug (that was sidebar flex-squeeze, fixed in Queue.tsx), but the failure
  // mode is identical in kind; single-threaded output removes it for a
  // negligible latency cost at our frame sizes.
  useThread: false,
  // The renderer renders on demand (requestRender), but frames are throttled
  // to maxFps; raise it from the default 60 so a keystroke's redraw is
  // scheduled within ~8ms instead of up to ~16ms.
  maxFps: 120,
  // Cells the renderer clears (including rows newly exposed by a resize,
  // before our boxes repaint) show this color instead of the terminal
  // default — kills the transient "gap" flash while resizing.
  backgroundColor: MAIN_BG,
  // Repaint sooner after SIGWINCH (default is 100ms of nothing).
  debounceDelay: 30,
  // Ctrl+C destroys the renderer, but our WebSocket + reconnect backoff (and
  // various timers) would keep the bun event loop alive; exit for real.
  onDestroy: () => {
    shuttingDown = true
    clearTimeout(reconnectTimer)
    try {
      ws?.close()
    } catch {}
    process.exit(0)
  },
})
