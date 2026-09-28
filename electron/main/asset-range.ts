/**
 * Byte-range support for the runbook-asset:// protocol handler.
 *
 * <video> and <audio> fetch media with `Range: bytes=N-` requests and can only
 * seek (or learn a WAV's duration) when the answer is a 206 Partial Content
 * with a Content-Range. The handler serves whole files with net.fetch(file://),
 * whose response never carries either, so ranged requests are answered here.
 */
import * as fs from "node:fs"
import { Readable } from "node:stream"

/** An inclusive byte range within a file. */
export interface ByteRange {
  start: number
  end: number
}

/**
 * Parse a Range header against a file of `size` bytes (RFC 9110 section 14.2).
 * Returns the one range to serve, "unsatisfiable" for a range that starts at
 * or past the end of the file (answered with 416), or null when the header is
 * absent or should be ignored, in which case the whole file is served as if
 * there were no header. A header is ignored when it is malformed, uses a unit
 * other than bytes, or asks for several ranges (media elements never do).
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header?.trim() ?? "")
  if (!match) return null
  const [, first, last] = match

  if (first === "") {
    // bytes=-N: the last N bytes
    if (last === "") return null
    const suffix = Number(last)
    if (suffix === 0 || size === 0) return "unsatisfiable"
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  // bytes=S- or bytes=S-E; an end before the start makes the header invalid
  const start = Number(first)
  if (last !== "" && Number(last) < start) return null
  if (start >= size) return "unsatisfiable"
  return { start, end: last === "" ? size - 1 : Math.min(Number(last), size - 1) }
}

/**
 * Answer a request for `filePath` that carried `rangeHeader`: 206 with just
 * the requested bytes, streamed from the file, or 416 for an unsatisfiable
 * range. Returns null when the header is ignored or the path is not a regular
 * file, so the caller serves the request as it would without a Range header.
 * `filePath` must already have passed the handler's containment check.
 */
export async function byteRangeResponse(
  filePath: string,
  rangeHeader: string,
  contentType: string,
): Promise<Response | null> {
  let size: number
  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile()) return null
    size = stat.size
  } catch {
    return null
  }

  const range = parseByteRange(rangeHeader, size)
  if (range === null) return null
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
    })
  }

  const { start, end } = range
  const body = Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    },
  })
}
