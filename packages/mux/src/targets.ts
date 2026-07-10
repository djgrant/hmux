/**
 * Display-target registry. A terminal that runs `mux target` registers its
 * tty here and parks as a tmux client on the hold session; the picker routes
 * opens to it (switch-client -c) instead of taking over its own terminal.
 * Files are advisory — the backend intersects them with live tmux clients,
 * so a stale file (crashed terminal) is ignored.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { DisplayTarget } from "./backend"

const DIR = process.env.MUX_STATE_DIR ?? join(homedir(), ".humans", "mux-targets")

/** Sessions mux manages for itself; hidden from the picker. */
export const HOLD_SESSION = "_mux-target"

const fileFor = (tty: string) => join(DIR, tty.replace(/[^a-zA-Z0-9]+/g, "-"))

export function registerTarget(tty: string, program: string | null): void {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(fileFor(tty), JSON.stringify({ tty, program }))
}

export function unregisterTarget(tty: string): void {
  try {
    rmSync(fileFor(tty), { force: true })
  } catch {}
}

export function registeredTargets(): DisplayTarget[] {
  try {
    return readdirSync(DIR).flatMap((f) => {
      const raw = readFileSync(join(DIR, f), "utf8").trim()
      try {
        const parsed = JSON.parse(raw)
        return parsed?.tty ? [{ tty: parsed.tty, program: parsed.program ?? null }] : []
      } catch {
        // Pre-JSON registry file: bare tty, program unknown.
        return raw ? [{ tty: raw, program: null }] : []
      }
    })
  } catch {
    return []
  }
}
