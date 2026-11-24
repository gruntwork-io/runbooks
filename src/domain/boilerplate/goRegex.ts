/**
 * Go regular expressions in JavaScript.
 *
 * Boilerplate compiles a `regex(...)` rule's pattern with Go's regexp package
 * (RE2 syntax). The form checks the same pattern with a JavaScript RegExp, so
 * this rewrites the RE2 syntax JavaScript spells differently, and rejects what
 * Go doesn't support (lookarounds, backreferences), which Boilerplate would
 * reject at render. Both engines then search the value unanchored, as Go's
 * MatchString does.
 */

/** A compiled pattern, or why it can't be compiled. */
export type CompiledGoRegex = { regex: RegExp } | { error: string }

// Characters JavaScript's `u` mode lets a backslash escape. Go lets a backslash
// escape any ASCII punctuation, so other escaped punctuation becomes the bare
// character (or `\-` inside a character class).
const JS_SYNTAX_CHARACTERS = new Set("^$\\.*+?()[]{}|/")

const POSIX_CLASSES: Record<string, string> = {
  alnum: "0-9A-Za-z",
  alpha: "A-Za-z",
  ascii: "\\x00-\\x7F",
  blank: "\\t ",
  cntrl: "\\x00-\\x1F\\x7F",
  digit: "0-9",
  graph: "!-~",
  lower: "a-z",
  print: " -~",
  punct: "!-\\/:-@\\[-`\\{-~",
  space: "\\t\\n\\v\\f\\r ",
  upper: "A-Z",
  word: "0-9A-Za-z_",
  xdigit: "0-9A-Fa-f",
}

const QUANTIFIER = /^\{\d+(,\d*)?\}/

const cache = new Map<string, CompiledGoRegex>()

/** Compiles a Go (RE2) pattern as a JavaScript RegExp. Results are cached by pattern. */
export function compileGoRegex(pattern: string): CompiledGoRegex {
  let compiled = cache.get(pattern)
  if (!compiled) {
    compiled = compile(pattern)
    cache.set(pattern, compiled)
  }
  return compiled
}

function compile(pattern: string): CompiledGoRegex {
  let source: string
  let flags = "u"
  try {
    const leadingFlags = /^\(\?([imsU]+)\)/.exec(pattern)
    if (leadingFlags) {
      for (const flag of new Set(leadingFlags[1])) {
        if (flag === "U") throw new Error("the U (ungreedy) flag has no JavaScript equivalent")
        flags += flag
      }
    }
    source = translate(pattern.slice(leadingFlags?.[0].length ?? 0))
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  try {
    return { regex: new RegExp(source, flags) }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { error: reason.replace(/^Invalid regular expression: /, "") }
  }
}

function translate(pattern: string): string {
  // By code point, as Go reads a pattern by rune
  const chars = Array.from(pattern)
  let out = ""
  let inClass = false
  // Index of the first character of the class body (after `[` or `[^`), where `]` is literal in Go
  let classBodyStart = -1

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!

    if (char === "\\") {
      const next = chars[i + 1]
      if (next === undefined) throw new Error("trailing backslash at end of expression")
      i++
      if (next === "Q") {
        // \Q...\E: everything up to \E (or the end) is literal
        let literal = ""
        let j = i + 1
        for (; j < chars.length; j++) {
          if (chars[j] === "\\" && chars[j + 1] === "E") break
          literal += chars[j]
        }
        out += escapeLiteral(literal, inClass)
        i = j < chars.length ? j + 1 : j
        continue
      }
      if (/[1-9]/.test(next)) throw new Error("Go doesn't support backreferences such as \\" + next)
      if (!inClass && next === "A") {
        out += "(?<![\\s\\S])"
        continue
      }
      if (!inClass && next === "z") {
        out += "(?![\\s\\S])"
        continue
      }
      if (next === "x" && chars[i + 1] === "{") {
        const close = chars.indexOf("}", i + 2)
        if (close === -1) throw new Error("missing } after \\x{")
        out += `\\u{${chars.slice(i + 2, close).join("")}}`
        i = close
        continue
      }
      if (next === "p" || next === "P") {
        let name: string
        if (chars[i + 1] === "{") {
          const close = chars.indexOf("}", i + 2)
          if (close === -1) throw new Error(`missing } after \\${next}{`)
          name = chars.slice(i + 2, close).join("")
          i = close
        } else {
          name = chars[i + 1] ?? ""
          i++
        }
        let negated = next === "P"
        if (name.startsWith("^")) {
          negated = !negated
          name = name.slice(1)
        }
        // One or two letters name a general category (L, Lu, Nd); longer names are scripts (Greek)
        const property = name.length <= 2 ? name : `Script=${name}`
        out += `\\${negated ? "P" : "p"}{${property}}`
        continue
      }
      if (/[!-/:-@[-`{-~]/.test(next)) {
        if (JS_SYNTAX_CHARACTERS.has(next) || (inClass && next === "-")) out += "\\" + next
        else out += next
        continue
      }
      out += "\\" + next
      continue
    }

    if (inClass) {
      if (char === "[" && chars[i + 1] === ":") {
        const close = chars.indexOf(":", i + 2)
        const name = close === -1 ? undefined : chars.slice(i + 2, close).join("")
        if (name !== undefined && chars[close + 1] === "]" && POSIX_CLASSES[name]) {
          out += POSIX_CLASSES[name]
          i = close + 1
          continue
        }
      }
      if (char === "]" && i === classBodyStart) {
        out += "\\]"
        continue
      }
      if (char === "]") inClass = false
      out += char
      continue
    }

    if (char === "[") {
      inClass = true
      out += char
      if (chars[i + 1] === "^") {
        out += "^"
        i++
      }
      classBodyStart = i + 1
      continue
    }

    if (char === "(" && chars[i + 1] === "?") {
      const rest = chars.slice(i + 2, i + 4).join("")
      if (rest.startsWith("=") || rest.startsWith("!") || rest === "<=" || rest === "<!") {
        throw new Error("Go doesn't support lookahead or lookbehind")
      }
      if (rest.startsWith("P<")) {
        out += "(?<"
        i += 3
        continue
      }
    }

    if (char === "{") {
      const quantifier = QUANTIFIER.exec(chars.slice(i).join(""))
      if (quantifier) {
        out += quantifier[0]
        i += quantifier[0].length - 1
      } else {
        out += "\\{"
      }
      continue
    }
    if (char === "}") {
      out += "\\}"
      continue
    }

    out += char
  }

  return out
}

function escapeLiteral(text: string, inClass: boolean): string {
  return text.replace(inClass ? /[\^$\\.*+?()[\]{}|/-]/g : /[\^$\\.*+?()[\]{}|/]/g, "\\$&")
}
