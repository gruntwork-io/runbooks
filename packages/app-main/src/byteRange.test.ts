import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Stream } from "effect"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { fileResponse, parseByteRange } from "./byteRange.ts"

describe("parseByteRange", () => {
  it("ignores a missing or empty header", () => {
    expect(parseByteRange(null, 100)).toBeUndefined()
    expect(parseByteRange("", 100)).toBeUndefined()
  })

  it("parses start-end, start- and a single byte", () => {
    expect(parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 })
    expect(parseByteRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 })
    expect(parseByteRange("bytes=42-42", 100)).toEqual({ start: 42, end: 42 })
  })

  it("clamps an end past the last byte", () => {
    expect(parseByteRange("bytes=90-1000", 100)).toEqual({ start: 90, end: 99 })
    expect(parseByteRange("bytes=0-99999999999999999999", 100)).toEqual({ start: 0, end: 99 })
  })

  it("parses a suffix range, capped at the whole file", () => {
    expect(parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 })
    expect(parseByteRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 })
  })

  it("treats the range unit case-insensitively and trims the header", () => {
    expect(parseByteRange("Bytes=0-4", 100)).toEqual({ start: 0, end: 4 })
    expect(parseByteRange("  bytes=0-4  ", 100)).toEqual({ start: 0, end: 4 })
  })

  it("reports a range that starts at or beyond the end as unsatisfiable", () => {
    expect(parseByteRange("bytes=100-", 100)).toBe("unsatisfiable")
    expect(parseByteRange("bytes=200-300", 100)).toBe("unsatisfiable")
    expect(parseByteRange("bytes=-0", 100)).toBe("unsatisfiable")
    expect(parseByteRange("bytes=0-", 0)).toBe("unsatisfiable")
    expect(parseByteRange("bytes=-5", 0)).toBe("unsatisfiable")
  })

  it("ignores malformed headers", () => {
    for (const header of [
      "bytes=abc",
      "bytes=5-2",
      "bytes=-",
      "bytes=",
      "items=0-5",
      "bytes 0-5",
      "bytes=0-5x",
      "bytes=1.5-2",
      "bytes=+1-2",
    ]) {
      expect(parseByteRange(header, 100)).toBeUndefined()
    }
  })

  it("ignores a multi-range request", () => {
    expect(parseByteRange("bytes=0-1,5-6", 100)).toBeUndefined()
    expect(parseByteRange("bytes=0-1, -5", 100)).toBeUndefined()
  })
})

describe("fileResponse", () => {
  let dir = ""
  let file = ""

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-byte-range-")))
    file = path.join(dir, "digits.wav")
    fs.writeFileSync(file, "0123456789")
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A moment for the body's reads to run, after a read or a cancel. */
  const settle = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 50)
    })

  const answer = (range: string | null, at = file, size = 10) =>
    Effect.runPromise(
      fileResponse(at, size, "audio/wav", range).pipe(Effect.provide(NodeFileSystemLive)),
    )

  it("serves just the requested bytes as 206 Partial Content", async () => {
    const res = await answer("bytes=2-5")
    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(res.headers.get("content-length")).toBe("4")
    expect(res.headers.get("accept-ranges")).toBe("bytes")
    expect(res.headers.get("content-type")).toBe("audio/wav")
    expect(await res.text()).toBe("2345")
  })

  it("serves an open-ended and a suffix range", async () => {
    const open = await answer("bytes=7-")
    expect(open.headers.get("content-range")).toBe("bytes 7-9/10")
    expect(await open.text()).toBe("789")

    const suffix = await answer("bytes=-4")
    expect(suffix.headers.get("content-range")).toBe("bytes 6-9/10")
    expect(await suffix.text()).toBe("6789")
  })

  it("answers an unsatisfiable range with 416 and the file size", async () => {
    const res = await answer("bytes=10-")
    expect(res.status).toBe(416)
    expect(res.headers.get("content-range")).toBe("bytes */10")
    expect(await res.text()).toBe("")
  })

  it("serves the whole file for no header or an ignored one, saying it takes ranges", async () => {
    for (const range of [null, "bytes=0-1,5-6", "bytes=5-2"]) {
      const res = await answer(range)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-length")).toBe("10")
      expect(res.headers.get("accept-ranges")).toBe("bytes")
      expect(res.headers.get("content-range")).toBeNull()
      expect(await res.text()).toBe("0123456789")
    }
  })

  it("serves an empty file whole, and refuses any range of it", async () => {
    const empty = path.join(dir, "empty.wav")
    fs.writeFileSync(empty, "")
    const whole = await answer(null, empty, 0)
    expect([whole.status, whole.headers.get("content-length"), await whole.text()]).toEqual([
      200,
      "0",
      "",
    ])
    expect((await answer("bytes=0-", empty, 0)).status).toBe(416)
  })

  it("answers an open range to the end of the file, reading it only as the body is taken, and stops when it is cancelled", async () => {
    const size = 8 * 1024 * 1024
    const large = path.join(dir, "large.wav")
    fs.writeFileSync(large, Buffer.alloc(size, 7))
    let read = 0
    let closed = false
    const res = await Effect.runPromise(
      Effect.gen(function* () {
        const files = yield* FileSystem
        const counted: FileSystem["Service"] = {
          ...files,
          readFileRange: (at, start, end) =>
            files.readFileRange(at, start, end).pipe(
              Stream.tap((chunk) => Effect.sync(() => (read += chunk.length))),
              Stream.ensuring(Effect.sync(() => (closed = true))),
            ),
        }
        return yield* fileResponse(large, size, "audio/wav", "bytes=1024-").pipe(
          Effect.provideService(FileSystem, counted),
        )
      }).pipe(Effect.provide(NodeFileSystemLive)),
    )
    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe(`bytes 1024-${size - 1}/${size}`)
    expect(res.headers.get("content-length")).toBe(String(size - 1024))

    const body = res.body?.getReader()
    const first = await body?.read()
    expect(first?.value?.length).toBeGreaterThan(0)
    await settle()
    expect(read).toBeLessThan(1024 * 1024)
    await body?.cancel()
    await settle()
    expect(closed).toBe(true)
    expect(read).toBeLessThan(1024 * 1024)
  })
})
