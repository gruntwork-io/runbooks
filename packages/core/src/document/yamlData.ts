/**
 * The data a parsed YAML document holds, for the YAML a runbook and its test
 * file hold: the front matter, a block's YAML children and `runbook_test.yml`.
 *
 * An alias may repeat a node, but it may not name a node that holds it,
 * since the data would then hold itself, and nothing that reads it would
 * end. Nor may aliases repeat so often that the data grows far past the
 * file: the yaml library refuses that ("Excessive alias count").
 */
import { Result } from "effect"
import { type Alias, type Document, visit } from "yaml"

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
