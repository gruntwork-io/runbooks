/**
 * A file main serves the window, answered whole or by byte range.
 *
 * `<video>` and `<audio>` fetch media with `Range: bytes=N-` requests and can
 * only seek, or learn a WAV's duration, when the answer is a 206 Partial
 * Content with a Content-Range.
 *
 * A ranged answer runs to the end of the range asked for, and an open range
 * to the end of the file. Chromium's media loader takes the length of a
 * resource whose URL is not http or https to be the answer's Content-Length
 * plus its start, so an answer cut short makes the media end where it
 * stops. What one answer reads is bounded by what the window takes: the
 * body is read from the file a chunk at a time as the window pulls it, and
 * the read stops, closing the file, when the window cancels it, as it does
 * on a seek.
 */
import { Effect, Stream } from "effect"
import { FileSystem } from "@runbooks/core/services/FileSystem"

/** An inclusive byte range within a file. */
interface ByteRange {
  readonly start: number
  readonly end: number
}

/**
 * The one range a Range header asks of a file of `size` bytes (RFC 9110
 * section 14.2), "unsatisfiable" for a range that starts at or past the end
 * of the file (a 416), or undefined when the header is absent or is ignored,
 * and the whole file is served as if there were none. A header is ignored
 * when it is malformed, uses a unit other than bytes, or asks for several
 * ranges (media elements never do).
 */
export function parseByteRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header?.trim() ?? "")
  if (match === null) return undefined
  const [, first = "", last = ""] = match
  if (first === "") {
    // bytes=-N: the last N bytes.
    if (last === "") return undefined
    const suffix = Number(last)
    if (suffix === 0 || size === 0) return "unsatisfiable"
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  // bytes=S- or bytes=S-E; an end before the start makes the header invalid.
  const start = Number(first)
  if (last !== "" && Number(last) < start) return undefined
  if (start >= size) return "unsatisfiable"
  return { start, end: last === "" ? size - 1 : Math.min(Number(last), size - 1) }
}

/**
 * The answer for `file`, a regular file of `size` bytes, to a request whose
 * Range header is `range` (null when it has none, or for a method other than
 * GET): a 206 with that range, a 416 for a range past its end, or the whole
 * file.
 */
export const fileResponse = (
  file: string,
  size: number,
  contentType: string,
  range: string | null,
): Effect.Effect<Response, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const asked = parseByteRange(range, size)
    if (asked === "unsatisfiable")
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
      })
    const { start, end } = asked ?? { start: 0, end: size - 1 }
    const length = end - start + 1
    const body = length === 0 ? null : Stream.toReadableStream(fs.readFileRange(file, start, end))
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
    }
    if (asked === undefined) return new Response(body, { status: 200, headers })
    return new Response(body, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` },
    })
  })
