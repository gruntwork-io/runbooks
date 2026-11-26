/**
 * The data a parsed YAML document holds, for every YAML an author writes:
 * a runbook's front matter, a block's YAML children and `runbook_test.yml`.
 *
 * An alias may repeat a node, but it may not name a node that holds it,
 * since the data would then hold itself, and nothing that reads it would
 * end. Nor may aliases repeat so often that the data grows far past the
 * file: the yaml library refuses that ("Excessive alias count").
 */
import { Result } from "effect"
import { type Document, isAlias, visit } from "yaml"

/** Why a document's data cannot be read, at the offset of its first alias. */
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
    const alias = firstAliasOffset(doc)
    return Result.fail(
      alias === undefined
        ? { message: `It could not be read: ${(error as Error).message}`, offset: 0 }
        : {
            message:
              "Its aliases repeat a node so often that the data would grow too large to read.",
            offset: alias,
          },
    )
  }
  if (holdsItself(data))
    return Result.fail({
      message: "An alias names a node that holds it, so the data would hold itself.",
      offset: firstAliasOffset(doc) ?? 0,
    })
  return Result.succeed(data)
}

/** Where the document's first alias starts, if it has one. */
function firstAliasOffset(doc: Document): number | undefined {
  let offset: number | undefined
  visit(doc, {
    Alias: (_, node) => {
      if (isAlias(node) && node.range) offset = node.range[0]
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
