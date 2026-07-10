#!/usr/bin/env bun
/**
 * humans-focus <tty> [term_program]
 *
 * Shell-friendly face for non-Bun consumers (the menu app calls out via
 * /bin/zsh -lc). Exits 0 even when focus doesn't land — best-effort by design.
 */
import { focusTerminal } from "./index"

const [tty, program] = process.argv.slice(2)
if (!tty) {
  console.error("usage: humans-focus <tty> [term_program]")
  process.exit(2)
}
await focusTerminal({ tty, program: program ?? null })
