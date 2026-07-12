/**
 * Ensure the hmux server (MCP + roster) is up, in the same spirit as
 * Backend.ensure(): every picker entrypoint makes the substrate ready.
 * The server outlives the picker — spawned detached, logging to
 * ~/.hmux/server.log — so agents keep their MCP endpoint after hmux exits.
 * Best-effort: when the port is busy or the spawn fails, the picker still
 * renders; the server is a plane the picker reads, not a dependency.
 */
import { homedir } from "os"
import { join } from "path"
import { mkdirSync, openSync } from "fs"

const BASE = process.env.HMUX_URL ?? "http://localhost:7373"
const ENTRY = join(import.meta.dir, "../../server/src/index.ts")

export async function ensureServer(): Promise<void> {
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(300) })
    return // something answers on the port — assume it's ours
  } catch {}
  try {
    const dir = join(homedir(), ".hmux")
    mkdirSync(dir, { recursive: true })
    const log = openSync(join(dir, "server.log"), "a")
    // cwd is the server package so its relative state (hmux.db) lands there.
    Bun.spawn(["bun", "run", ENTRY], {
      cwd: join(import.meta.dir, "../../server"),
      stdin: "ignore",
      stdout: log,
      stderr: log,
    }).unref()
  } catch {}
}
