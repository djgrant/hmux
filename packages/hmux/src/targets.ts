/**
 * Display-target registry. A terminal that runs `hmux target` registers its
 * tty here and parks as a tmux client on the hold session; the picker routes
 * opens to it (switch-client -c) instead of taking over its own terminal.
 * Files are advisory — the backend intersects them with live tmux clients,
 * so a stale file (crashed terminal) is ignored.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { DisplayTarget } from "./backend"

const DIR = process.env.HMUX_TARGETS_DIR ?? join(homedir(), ".hmux", "hmux-targets")

/** Sessions hmux manages for itself; hidden from the picker. */
export const HOLD_SESSION = "_mux-target"

const fileFor = (tty: string) => join(DIR, tty.replace(/[^a-zA-Z0-9]+/g, "-"))

export function registerTarget(tty: string, program: string | null): void {
  mkdirSync(DIR, { recursive: true })
  // pid proves ownership: a hard-killed target (closed window, SIGHUP) skips
  // its unregister, and the freed tty gets recycled — without the pid check
  // a stale file would claim whatever tmux client lands on that tty next.
  writeFileSync(fileFor(tty), JSON.stringify({ tty, program, pid: process.pid }))
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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
      let parsed: { tty?: string; program?: string; pid?: number } | null = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Pre-pid registry file: bare tty. No owner to verify — reap it.
      }
      if (!parsed?.tty || !parsed.pid || !pidAlive(parsed.pid)) {
        try {
          rmSync(join(DIR, f), { force: true })
        } catch {}
        return []
      }
      return [{ tty: parsed.tty, program: parsed.program ?? null }]
    })
  } catch {
    return []
  }
}
