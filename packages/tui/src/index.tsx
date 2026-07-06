import { Show } from "solid-js"
import { render, useKeyboard } from "@opentui/solid"
import {
  DEFAULT_PORT,
  WS_PATH,
  isServerEvent,
  type ClientEvent,
} from "@humans/protocol"
import {
  activeMessage,
  addMessage,
  advance,
  applyInit,
  closeQueue,
  drafts,
  markAnswered,
  moveHighlight,
  openQueue,
  setConn,
  state,
} from "./store"
import { MessageView } from "./components/MessageView"
import { Composer } from "./components/Composer"
import { Queue } from "./components/Queue"
import { Footer } from "./components/Footer"

// --- WebSocket client --------------------------------------------------------

const port = Number(process.env.HUMANS_PORT) || DEFAULT_PORT
const url = `ws://localhost:${port}${WS_PATH}`

let ws: WebSocket | null = null
let attempts = 0

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
    if (data.type === "init") applyInit(data.messages)
    else if (data.type === "message.new") addMessage(data.message)
    else if (data.type === "message.answered") markAnswered(data.id, data.answer, data.answeredAt)
  }
  ws.onclose = () => {
    setConn("reconnecting")
    const delay = Math.min(1000 * 2 ** attempts, 15_000)
    attempts++
    setTimeout(connect, delay)
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

// --- App ----------------------------------------------------------------------

const DIM = "#7a7a7a"

function App() {
  useKeyboard((key) => {
    if (state.mode === "queue") {
      if (key.name === "up") moveHighlight(-1)
      else if (key.name === "down") moveHighlight(1)
      else if (key.name === "return") closeQueue(true)
      else if (key.name === "escape") closeQueue(false)
    } else if (!activeMessage()) {
      // Empty state: still allow opening the queue (e.g. to review answered).
      if (key.shift && (key.name === "up" || key.name === "down")) {
        openQueue(key.name === "down" ? 1 : -1)
      }
    }
  })

  const handleSend = (text: string) => {
    const msg = activeMessage()
    if (!msg) return
    if (!sendAnswer(msg.id, text)) return
    drafts.delete(msg.id)
    markAnswered(msg.id, text, Date.now())
  }

  return (
    <box flexDirection="column" height="100%" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexGrow={1}>
        <Show when={state.mode === "queue"}>
          <Queue />
        </Show>
        <box flexDirection="column" flexGrow={1}>
          <Show
            when={activeMessage()}
            keyed
            fallback={
              <box flexGrow={1} justifyContent="center" alignItems="center">
                <text fg={DIM}>no messages — agents will appear here</text>
              </box>
            }
          >
            {(msg) => (
              <>
                <MessageView message={msg} />
                <Composer
                  messageId={msg.id}
                  focused={state.mode === "next"}
                  onSend={handleSend}
                  onSkip={advance}
                />
              </>
            )}
          </Show>
        </box>
      </box>
      <Footer />
    </box>
  )
}

connect()
render(() => <App />)
