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
import { mkdirSync, openSync, existsSync } from "fs"

const BASE = process.env.HMUX_URL ?? "http://localhost:7373"
// The server ships inside hmux. In a published build it's the bundled
// `server.js` sitting beside this module in dist/; in the monorepo it's the
// sibling `server` package's source. HMUX_SERVER_ENTRY overrides both.
const ENTRY =
  process.env.HMUX_SERVER_ENTRY ??
  [
    join(import.meta.dir, "server.js"), // published: dist/cli.js + dist/server.js
    join(import.meta.dir, "../../server/src/index.ts"), // monorepo dev
  ].find(existsSync)!

export async function ensureServer(): Promise<void> {
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(300) })
    return // something answers on the port — assume it's ours
  } catch {}
  try {
    const dir = join(homedir(), ".hmux")
    mkdirSync(dir, { recursive: true })
    const log = openSync(join(dir, "server.log"), "a")
    // cwd is ~/.hmux so the server's relative state (hmux.db) lands there,
    // not next to the install.
    Bun.spawn(["bun", "run", ENTRY], {
      cwd: dir,
      stdin: "ignore",
      stdout: log,
      stderr: log,
    }).unref()
  } catch {}
}
