/**
 * Splits a byte stream into lines as readline does, at "\n", "\r\n" or a
 * lone "\r", for a child's pipes and the log files it writes. A line longer
 * than `MAX_LINE_LENGTH` characters comes out in pieces of that length, each
 * but the last said to continue, and no more than that of a line that has
 * not ended is held, so one huge line costs no more memory than many short
 * ones.
 */
import { StringDecoder } from "node:string_decoder"

/** The longest line, in characters, that comes out whole. */
export const MAX_LINE_LENGTH = 64 * 1024

export interface LineSplitter {
  /** Takes the next bytes and emits each line they end. */
  readonly write: (chunk: Buffer) => void
  /** Emits the last line if it has no line break. */
  readonly end: () => void
}

export function lineSplitter(
  onLine: (line: string, continues: boolean) => void,
  maxLength: number = MAX_LINE_LENGTH,
): LineSplitter {
  const decoder = new StringDecoder("utf8")
  let rest = ""
  /** Emits each whole piece of `text` and gives back what is left, at most `maxLength`. */
  const pieces = (text: string): string => {
    while (text.length > maxLength) {
      // A piece never ends between the two halves of a surrogate pair.
      const high = text.charCodeAt(maxLength - 1)
      const cut = high >= 0xd800 && high <= 0xdbff ? maxLength - 1 : maxLength
      onLine(text.slice(0, cut), true)
      text = text.slice(cut)
    }
    return text
  }
  const take = (text: string, ended: boolean) => {
    rest += text
    let start = 0
    for (const found of rest.matchAll(/\r\n|\r|\n/g)) {
      // A "\r" last in what has arrived may be the first half of "\r\n".
      if (!ended && found[0] === "\r" && found.index === rest.length - 1) break
      onLine(pieces(rest.slice(start, found.index)), false)
      start = found.index + found[0].length
    }
    rest = pieces(rest.slice(start))
    if (ended && rest !== "") {
      onLine(rest, false)
      rest = ""
    }
  }
  return {
    write: (chunk) => take(decoder.write(chunk), false),
    end: () => take(decoder.end(), true),
  }
}
