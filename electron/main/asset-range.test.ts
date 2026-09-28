import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { byteRangeResponse, parseByteRange } from "./asset-range.ts"

describe("parseByteRange", () => {
  it("ignores a missing or empty header", () => {
    expect(parseByteRange(null, 100)).toBeNull()
    expect(parseByteRange(undefined, 100)).toBeNull()
    expect(parseByteRange("", 100)).toBeNull()
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
    for (const header of ["bytes=abc", "bytes=5-2", "bytes=-", "bytes=", "items=0-5", "bytes 0-5", "bytes=0-5x", "bytes=1.5-2", "bytes=+1-2"]) {
      expect(parseByteRange(header, 100)).toBeNull()
    }
  })

  it("ignores a multi-range request", () => {
    expect(parseByteRange("bytes=0-1,5-6", 100)).toBeNull()
    expect(parseByteRange("bytes=0-1, -5", 100)).toBeNull()
  })
})

describe("byteRangeResponse", () => {
  let dir = ""
  let file = ""

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-asset-range-"))
    file = path.join(dir, "digits.wav")
    fs.writeFileSync(file, "0123456789")
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("serves just the requested bytes as 206 Partial Content", async () => {
    const res = await byteRangeResponse(file, "bytes=2-5", "audio/wav")

    expect(res?.status).toBe(206)
    expect(res?.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(res?.headers.get("content-length")).toBe("4")
    expect(res?.headers.get("accept-ranges")).toBe("bytes")
    expect(res?.headers.get("content-type")).toBe("audio/wav")
    expect(await res?.text()).toBe("2345")
  })

  it("serves an open-ended and a suffix range", async () => {
    const open = await byteRangeResponse(file, "bytes=7-", "audio/wav")
    expect(open?.headers.get("content-range")).toBe("bytes 7-9/10")
    expect(await open?.text()).toBe("789")

    const suffix = await byteRangeResponse(file, "bytes=-4", "audio/wav")
    expect(suffix?.headers.get("content-range")).toBe("bytes 6-9/10")
    expect(await suffix?.text()).toBe("6789")
  })

  it("answers an unsatisfiable range with 416 and the file size", async () => {
    const res = await byteRangeResponse(file, "bytes=10-", "audio/wav")

    expect(res?.status).toBe(416)
    expect(res?.headers.get("content-range")).toBe("bytes */10")
    expect(await res?.text()).toBe("")
  })

  it("returns null, so the caller serves the whole file, for an ignored header", async () => {
    expect(await byteRangeResponse(file, "bytes=0-1,5-6", "audio/wav")).toBeNull()
    expect(await byteRangeResponse(file, "bytes=5-2", "audio/wav")).toBeNull()
  })

  it("returns null for a directory or a missing file", async () => {
    expect(await byteRangeResponse(dir, "bytes=0-", "audio/wav")).toBeNull()
    expect(await byteRangeResponse(path.join(dir, "missing.wav"), "bytes=0-", "audio/wav")).toBeNull()
  })
})
