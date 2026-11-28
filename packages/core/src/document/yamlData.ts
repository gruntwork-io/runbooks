/**
 * The YAML a runbook and its files hold, parsed, and the data it holds: the
 * front matter, a block's YAML children, `runbook_test.yml` and
 * `boilerplate.yml`.
 *
 * An error says where and why in words of Runbooks' own, and quotes none of
 * the text. The yaml library's messages hold the lines around a mistake, and
 * some quote the text at it, so a secret written beside a mistake (a
 * sensitive field's default) would show in an error that `validate` prints
 * and every client of the engine gets.
 *
 * An alias may repeat a node, but it may not name a node that holds it,
 * since the data would then hold itself, and nothing that reads it would
 * end. Nor may aliases repeat so often that the data grows far past the
 * file: the yaml library refuses that ("Excessive alias count").
 */
import { Result } from "effect"
import {
  type Alias,
  type Document,
  type ErrorCode,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  parseDocument,
  visit,
} from "yaml"

/** Why YAML could not be parsed, for each error the yaml library gives: never its message. */
const REASONS: { readonly [Code in ErrorCode]: string } = {
  ALIAS_PROPS: "an alias has an anchor or a tag, which it can't",
  BAD_ALIAS: "an anchor or alias name is empty or ends in a colon",
  BAD_COLLECTION_TYPE: "a tag is for another kind of collection than the one it is on",
  BAD_DIRECTIVE: "a `%` directive isn't one YAML knows",
  BAD_DQ_ESCAPE:
    "a double-quoted value has a backslash escape YAML doesn't know (single quotes keep a backslash as it is)",
  BAD_INDENT: "the indentation doesn't line up",
  BAD_PROP_ORDER: "an anchor or tag comes before an indicator it must follow",
  BAD_SCALAR_START: "a plain value starts with a character YAML reserves; quote the value",
  BLOCK_AS_IMPLICIT_KEY: "a list or map is used as a key",
  BLOCK_IN_FLOW: "a block list or map is inside `[ ]` or `{ }`",
  DUPLICATE_KEY: "a key appears twice in one map",
  IMPOSSIBLE: "the YAML can't be read here",
  KEY_OVER_1024_CHARS: "a key is longer than 1024 characters",
  MISSING_CHAR:
    "a character is missing: a closing quote, a comma, a colon or space after a key, or a `-` before a list item",
  MULTILINE_IMPLICIT_KEY: "a key runs over more than one line",
  MULTIPLE_ANCHORS: "a node has more than one anchor",
  MULTIPLE_DOCS: "it holds more than one YAML document",
  MULTIPLE_TAGS: "a node has more than one tag",
  NON_STRING_KEY: "a key isn't text",
  // The library says so for a stack overflow while it builds a list or map, which only nesting causes.
  RESOURCE_EXHAUSTION: "its lists and maps are nested too deep to read",
  TAB_AS_INDENT: "a tab indents a line; YAML indents with spaces only",
  TAG_RESOLVE_FAILED: "a `!` tag isn't one YAML knows",
  UNEXPECTED_TOKEN:
    "something here doesn't belong, such as a stray comma or text after a block scalar's `|` or `>`",
}

/** Where YAML fails to parse, in its own text, and why. */
export interface YamlProblem {
  /** 1-based. */
  readonly line: number
  /** 1-based. */
  readonly column: number
  readonly reason: string
}

/**
 * `text` parsed as one YAML document, each of its errors as a problem, and
 * its line counter for placing an offset in it.
 */
export function parseYaml(text: string): {
  readonly doc: Document.Parsed
  readonly lines: LineCounter
  readonly problems: ReadonlyArray<YamlProblem>
} {
  const lines = new LineCounter()
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false })
  return {
    doc,
    lines,
    problems: doc.errors.map((error) => {
      const { line, col } = lines.linePos(error.pos[0])
      return { line, column: col, reason: REASONS[error.code] }
    }),
  }
}

/**
 * The YAML node a decode issue at `path` points at: for a key, the key
 * itself, so an unexpected key's line is its own; for a key that is
 * missing, the map that lacks it.
 */
export function nodeAt(root: Node | null, path: ReadonlyArray<PropertyKey>): Node | null {
  let node = root
  for (const [i, key] of path.entries()) {
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(key))
      if (pair === undefined) return node
      if (i === path.length - 1) return pair.key as Node
      node = pair.value as Node | null
    } else if (isSeq(node)) {
      const item = typeof key === "number" ? node.items[key] : undefined
      if (item === undefined) return node
      node = item as Node
    } else return node
  }
  return node
}

/** Why a document's data cannot be read, and the offset of the alias at fault. */
export interface YamlDataProblem {
  readonly message: string
  readonly offset: number
}

/** The data `doc` holds, or why it cannot be read. `doc` parsed without errors. */
export function yamlData(doc: Document): Result.Result<unknown, YamlDataProblem> {
  let data: unknown
  try {
    data = doc.toJS()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The library refuses an alias bomb with this message; it has no type.
    return Result.fail(
      message.includes("Excessive alias count")
        ? {
            message:
              "Its aliases repeat a node so often that the data would grow too large to read.",
            offset: aliasOffset(doc, () => true),
          }
        : { message: `It could not be read: ${message}`, offset: 0 },
    )
  }
  if (holdsItself(data))
    return Result.fail({
      message: "An alias names a node that holds it, so the data would hold itself.",
      offset: aliasOffset(doc, (alias, path) => {
        const named = alias.resolve(doc)
        return named !== undefined && path.includes(named)
      }),
    })
  return Result.succeed(data)
}

/** Where the first alias `matches` starts, or the document's start if none does. */
function aliasOffset(
  doc: Document,
  matches: (alias: Alias, path: readonly unknown[]) => boolean,
): number {
  let offset = 0
  visit(doc, {
    Alias: (_, node, path) => {
      if (!matches(node, path) || !node.range) return undefined
      offset = node.range[0]
      return visit.BREAK
    },
  })
  return offset
}

/**
 * Whether a list or map in `data` holds itself, at any depth. A loop, not
 * recursion, so deeply nested data cannot overflow the stack.
 */
function holdsItself(data: unknown): boolean {
  const done = new Set<object>()
  const open = new Set<object>()
  const path: Array<{ readonly node: object; readonly children: unknown[]; next: number }> = []
  /** Starts on `value`; true if it is already on the path, a loop. */
  const enter = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null || done.has(value)) return false
    if (open.has(value)) return true
    open.add(value)
    const children = value instanceof Map ? [...value.values()] : Object.values(value)
    path.push({ node: value, children, next: 0 })
    return false
  }
  if (enter(data)) return true
  for (let top = path.at(-1); top !== undefined; top = path.at(-1)) {
    if (top.next < top.children.length) {
      if (enter(top.children[top.next++])) return true
    } else {
      open.delete(top.node)
      done.add(top.node)
      path.pop()
    }
  }
  return false
}
