import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireSaveLock } from "../src/tmux"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmdirSync(dir)
})

describe("tmux snapshot saving", () => {
  test("only one process can own the save lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "hmux-save-"))
    dirs.push(dir)
    const lock = join(dir, "save.lock")

    const release = acquireSaveLock(lock)
    expect(release).toBeFunction()
    expect(acquireSaveLock(lock)).toBeNull()

    release!()
    const releaseAgain = acquireSaveLock(lock)
    expect(releaseAgain).toBeFunction()
    releaseAgain!()
  })
})
