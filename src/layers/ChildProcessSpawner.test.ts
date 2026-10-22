import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { openFileTail } from "./ChildProcessSpawner.ts"

describe("openFileTail", () => {
  let dir: string
  let file: string
  let lines: string[]

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-tail-test-"))
    file = path.join(dir, "info.log")
    lines = []
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const tail = () => openFileTail(file, (line) => lines.push(line))

  it("emits complete lines as they are appended, holding back a partial one", () => {
    fs.writeFileSync(file, "")
    const t = tail()
    fs.appendFileSync(file, "one\ntw")
    t.read()
    expect(lines).toEqual(["one"])
    fs.appendFileSync(file, "o\r\nthree\n")
    t.read()
    expect(lines).toEqual(["one", "two", "three"])
    t.read()
    expect(lines).toEqual(["one", "two", "three"])
    t.finish()
  })

  it("emits a last line with no newline on finish, and nothing after", () => {
    fs.writeFileSync(file, "one\nlast")
    const t = tail()
    t.read()
    expect(lines).toEqual(["one"])
    t.finish()
    expect(lines).toEqual(["one", "last"])
    fs.appendFileSync(file, "\nlater\n")
    t.read()
    t.finish()
    expect(lines).toEqual(["one", "last"])
  })

  it("keeps a multi-byte character split across reads whole", () => {
    fs.writeFileSync(file, "")
    const t = tail()
    const bytes = Buffer.from("café ✓\n")
    fs.appendFileSync(file, bytes.subarray(0, 4)) // "caf" + the first byte of "é"
    t.read()
    fs.appendFileSync(file, bytes.subarray(4))
    t.finish()
    expect(lines).toEqual(["café ✓"])
  })

  it("reads more than one buffer's worth in a single read", () => {
    fs.writeFileSync(file, "")
    const t = tail()
    const many = Array.from({ length: 20000 }, (_, i) => `line ${i + 1}`)
    fs.appendFileSync(file, many.join("\n") + "\n")
    t.read()
    expect(lines).toEqual(many)
    t.finish()
  })

  it("opens a file that appears after the tail starts", () => {
    const t = tail()
    t.read()
    fs.writeFileSync(file, "late\n")
    t.read()
    expect(lines).toEqual(["late"])
    t.finish()
  })

  it("starts over from the top when the file is overwritten with less", () => {
    fs.writeFileSync(file, "a long first line\n")
    const t = tail()
    t.read()
    fs.writeFileSync(file, "new\n")
    t.finish()
    expect(lines).toEqual(["a long first line", "new"])
  })
})
