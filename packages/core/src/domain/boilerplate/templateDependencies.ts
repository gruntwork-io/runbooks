/**
 * What a template reads: its `{{ .inputs.X }}` and `{{ .outputs.X.Y }}`
 * references. A block waits to run or render until all of them have values.
 *
 * The one extractor for both processes. Main uses it for the outputs a
 * Template block's files read (src/domain/boilerplate/config.ts), the
 * renderer for every other block (web/src/lib/extractTemplateDependencies.ts),
 * so a reference means the same thing to both. The renderer bundles this
 * module directly, so it must stay free of Node and Electron imports.
 */

import { scanGuardedCode } from "./outputGuards.ts"

/**
 * A dependency found in a template:
 * - `input`: `{{ .inputs.region }}` needs an input value named "region"
 * - `output`: `{{ .outputs.create_account.account_id }}` needs output
 *   "account_id" from block "create_account"
 *
 * An output dependency is `optional` when every reference to it sits behind a
 * `hasKey .outputs.create_account "account_id"` guard (see scanGuardedCode):
 * the block must have run, but the output itself may be absent.
 */
export type TemplateDependency =
  | { type: "input"; name: string }
  | {
      type: "output"
      blockId: string
      outputName: string
      /** `outputs.<block_id>.<output_name>`, with the block ID normalized */
      fullPath: string
      optional?: boolean
    }

/**
 * `.inputs.<path>` or `.outputs.<block_id>.<output_name>`.
 *
 * An input path keeps its dots: `.inputs.tags.env` reads key `env` of a Map
 * input. An output name is an identifier, like every key a block can output,
 * so `.outputs.blk.a.b` reads output `a`. Block IDs may be written with
 * hyphens (`create-account`); they're normalized for lookup.
 */
const REFERENCE_PATTERN =
  /\.inputs\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)|\.outputs\.([a-zA-Z0-9_-]+)\.(\w+)/g

/**
 * The dependencies in one or more templates, in the order they first appear.
 * Only references inside `{{ }}` actions count, not ones in template comments
 * or plain text.
 *
 * A `hasKey` guard covers only the content it's in, so pass separate
 * templates (files, props) as separate arguments: an output read unguarded in
 * any of them is required.
 */
export function extractTemplateDependenciesFromString(
  ...contents: ReadonlyArray<string>
): TemplateDependency[] {
  const deps: TemplateDependency[] = []
  const inputs = new Set<string>()
  const outputs = new Map<string, Extract<TemplateDependency, { type: "output" }>>()

  for (const content of contents) {
    if (!content) continue
    for (const { code, guarded } of scanGuardedCode(content)) {
      for (const [, inputName, blockId, outputName] of code.matchAll(REFERENCE_PATTERN)) {
        if (inputName) {
          if (inputs.has(inputName)) continue
          inputs.add(inputName)
          deps.push({ type: "input", name: inputName })
        } else if (blockId && outputName) {
          // create-account and create_account are the same block
          const fullPath = `outputs.${blockId.replaceAll("-", "_")}.${outputName}`
          const optional = guarded.has(fullPath)

          const existing = outputs.get(fullPath)
          if (existing) {
            // One unguarded reference makes the output required.
            if (!optional) delete existing.optional
            continue
          }
          const dep = {
            type: "output" as const,
            blockId,
            outputName,
            fullPath,
            ...(optional ? { optional: true } : {}),
          }
          outputs.set(fullPath, dep)
          deps.push(dep)
        }
      }
    }
  }

  return deps
}
