/**
 * Unified template dependency extraction for {{ .inputs.X }} / {{ .outputs.X.Y }} syntax.
 *
 * Single-pass parser that classifies dependencies by namespace prefix.
 *
 * Used by useTemplateDependencies hook and any block that needs to discover what
 * template expressions its props/content contain.
 */

import type { ReactNode } from "react"
import { normalizeBlockId } from "@/lib/utils"
import type { InputName, BlockId, OutputName } from "@/lib/templateUtils"

/**
 * Represents a dependency extracted from a template expression.
 * Discriminated union on `type`:
 * - 'input': {{ .inputs.region }} → needs an input value named "region"
 * - 'output': {{ .outputs.create_account.account_id }} → needs output "account_id" from block "create_account"
 *
 * An output dependency is `optional` when the content guards it with
 * `hasKey .outputs.create_account "account_id"`: the block must have run, but
 * the output itself may be absent.
 */
export type TemplateDependency =
  | { type: "input"; name: InputName }
  | {
      type: "output"
      blockId: BlockId
      outputName: OutputName
      fullPath: string
      optional?: boolean
    }

/**
 * A `hasKey .outputs.X "Y"` guard (the map may be parenthesized, the key
 * double-quoted or backquoted). Templates render with missing-key-action=error,
 * so this is the one way to read an output a block emits only sometimes.
 */
const OUTPUT_GUARD_PATTERN =
  /\bhasKey\s+\(?\s*\.outputs\.([a-zA-Z0-9_-]+)\s*\)?\s+(?:"([a-zA-Z0-9_-]+)"|`([a-zA-Z0-9_-]+)`)/g

// OutputDependency is defined canonically alongside the boilerplate config types.
// Import it for local use below, and re-export so existing importers keep a
// single source of truth. (BlockId/OutputName are string aliases, so the shapes
// are identical.)
import type { OutputDependency } from "@/types/boilerplateConfig"
export type { OutputDependency }

/**
 * Extract all template dependencies from a string using the new syntax.
 *
 * Recognizes:
 * - {{ .inputs.VarName }} → input dependency
 * - {{ .outputs.block_id.output_name }} → output dependency
 * - Handles optional whitespace trimming markers (-) and pipe functions (| upper)
 *
 * Two-pass extraction: first find all {{ }} template blocks, then scan each
 * block for .inputs.X and .outputs.X.Y references. This correctly handles
 * references inside function calls (e.g., fromJson) while ignoring occurrences
 * outside template delimiters (e.g., in comments).
 *
 * @param content - String content to search for dependencies
 * @returns Array of TemplateDependency objects found in the template
 */
export function extractTemplateDependenciesFromString(content: string): TemplateDependency[] {
  if (!content) return []

  const deps: TemplateDependency[] = []
  const seen = new Set<string>()
  const guarded = new Set<string>()

  // First pass: find all {{ }} template blocks
  const blockRegex = /\{\{-?([\s\S]*?)-?\}\}/g
  let blockMatch

  while ((blockMatch = blockRegex.exec(content)) !== null) {
    // Group 1 isn't optional, so a match always has it.
    const blockContent = blockMatch[1]!

    OUTPUT_GUARD_PATTERN.lastIndex = 0
    for (const [, blockId, quoted, backquoted] of blockContent.matchAll(OUTPUT_GUARD_PATTERN)) {
      // Group 1 isn't optional, so a match always has it.
      guarded.add(`outputs.${normalizeBlockId(blockId!)}.${quoted ?? backquoted}`)
    }

    // Second pass: find .inputs.X and .outputs.X.Y references within the block
    // Allow hyphens in path segments — block IDs in MDX use hyphens (e.g., create-account)
    const refRegex = /\.(?:inputs|outputs)\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*/g
    let refMatch

    while ((refMatch = refRegex.exec(blockContent)) !== null) {
      const path = refMatch[0].slice(1) // Remove leading dot

      if (seen.has(path)) continue

      if (path.startsWith("inputs.")) {
        const name = path.slice("inputs.".length)
        if (name) {
          seen.add(path)
          deps.push({ type: "input", name })
        }
      } else if (path.startsWith("outputs.")) {
        const rest = path.slice("outputs.".length)
        const dotIdx = rest.indexOf(".")
        if (dotIdx > 0) {
          const originalBlockId = rest.slice(0, dotIdx)
          const normalizedBlockId = normalizeBlockId(originalBlockId)
          const outputName = rest.slice(dotIdx + 1)
          // Use normalized path for deduplication (create-account and create_account are the same)
          const normalizedPath = `outputs.${normalizedBlockId}.${outputName}`

          if (!seen.has(normalizedPath)) {
            seen.add(normalizedPath)
            deps.push({
              type: "output",
              blockId: originalBlockId,
              outputName,
              fullPath: normalizedPath,
            })
          }
        }
      }
    }
  }

  // The guard and the reference usually sit in separate actions
  // (`{{ if hasKey ... }}{{ .outputs.x.y }}{{ end }}`), so guards are applied
  // after the whole content has been scanned.
  for (const dep of deps) {
    if (dep.type === "output" && guarded.has(dep.fullPath)) dep.optional = true
  }

  return deps
}

/**
 * Split mixed dependencies into typed groups for use by
 * computeUnmetInputDependencies and computeUnmetOutputDependencies.
 *
 * Deduplicates within each group.
 */
export function splitDependencies(deps: TemplateDependency[]): {
  inputs: InputName[]
  outputs: OutputDependency[]
} {
  const inputs: InputName[] = []
  const outputs: OutputDependency[] = []
  const seenInputs = new Set<string>()
  const seenOutputs = new Map<string, OutputDependency>()

  for (const dep of deps) {
    if (dep.type === "input") {
      if (!seenInputs.has(dep.name)) {
        seenInputs.add(dep.name)
        inputs.push(dep.name)
      }
    } else {
      const existing = seenOutputs.get(dep.fullPath)
      if (existing) {
        // One unguarded reference makes the output required everywhere.
        if (!dep.optional) delete existing.optional
        continue
      }
      const output: OutputDependency = {
        blockId: dep.blockId,
        outputName: dep.outputName,
        fullPath: dep.fullPath,
        ...(dep.optional ? { optional: true } : {}),
      }
      seenOutputs.set(dep.fullPath, output)
      outputs.push(output)
    }
  }

  return { inputs, outputs }
}

/**
 * Extract template dependencies from React children nodes.
 *
 * MDX compiles code blocks into nested React elements (`<pre>` → `<code>` → text).
 * This function walks the React element tree to collect all text strings, then
 * feeds each to extractTemplateDependenciesFromString.
 *
 * Used by TemplateInline where template content arrives as React children,
 * not as a string prop.
 *
 * @param children - React children nodes containing template content
 * @returns Array of TemplateDependency objects found in the template
 */
export function extractTemplateDependencies(children: ReactNode): TemplateDependency[] {
  const allDeps: TemplateDependency[] = []
  const seen = new Set<string>()

  const collectFromString = (text: string) => {
    const deps = extractTemplateDependenciesFromString(text)
    for (const dep of deps) {
      const key = dep.type === "input" ? `input:${dep.name}` : dep.fullPath
      if (!seen.has(key)) {
        seen.add(key)
        allDeps.push(dep)
      }
    }
  }

  const traverse = (node: ReactNode): void => {
    if (typeof node === "string") {
      collectFromString(node)
    } else if (Array.isArray(node)) {
      node.forEach(traverse)
    } else if (node && typeof node === "object" && "props" in node) {
      const element = node as { props?: { children?: ReactNode; value?: string } }
      if (element.props?.value) {
        collectFromString(element.props.value)
      }
      if (element.props?.children) {
        traverse(element.props.children)
      }
    }
  }

  traverse(children)
  return allDeps
}
