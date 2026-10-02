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
import { scanGuardedCode } from "../../../src/domain/boilerplate/outputGuards"

/**
 * Represents a dependency extracted from a template expression.
 * Discriminated union on `type`:
 * - 'input': {{ .inputs.region }} → needs an input value named "region"
 * - 'output': {{ .outputs.create_account.account_id }} → needs output "account_id" from block "create_account"
 *
 * An output dependency is `optional` when every reference to it sits behind a
 * `hasKey .outputs.create_account "account_id"` guard (see scanGuardedCode):
 * the block must have run, but the output itself may be absent.
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
 * Two-pass extraction: scanGuardedCode finds the code inside {{ }} actions
 * (skipping template comments), then each part is scanned for .inputs.X and
 * .outputs.X.Y references. This correctly handles references inside function
 * calls (e.g., fromJson) while ignoring occurrences outside template
 * delimiters.
 *
 * @param content - String content to search for dependencies
 * @returns Array of TemplateDependency objects found in the template
 */
export function extractTemplateDependenciesFromString(content: string): TemplateDependency[] {
  if (!content) return []

  const deps: TemplateDependency[] = []
  const seenInputs = new Set<string>()
  const outputs = new Map<string, Extract<TemplateDependency, { type: "output" }>>()

  // Allow hyphens in path segments — block IDs in MDX use hyphens (e.g., create-account)
  const refRegex = /\.(?:inputs|outputs)\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*/g

  for (const { code, guarded } of scanGuardedCode(content)) {
    for (const [ref] of code.matchAll(refRegex)) {
      const path = ref.slice(1) // Remove leading dot

      if (path.startsWith("inputs.")) {
        const name = path.slice("inputs.".length)
        if (name && !seenInputs.has(name)) {
          seenInputs.add(name)
          deps.push({ type: "input", name })
        }
      } else if (path.startsWith("outputs.")) {
        const rest = path.slice("outputs.".length)
        const dotIdx = rest.indexOf(".")
        if (dotIdx > 0) {
          const originalBlockId = rest.slice(0, dotIdx)
          const outputName = rest.slice(dotIdx + 1)
          // Use normalized path for deduplication (create-account and create_account are the same)
          const normalizedPath = `outputs.${normalizeBlockId(originalBlockId)}.${outputName}`
          const optional = guarded.has(normalizedPath)

          const existing = outputs.get(normalizedPath)
          if (existing) {
            // One unguarded reference makes the output required.
            if (!optional) delete existing.optional
            continue
          }
          const dep = {
            type: "output" as const,
            blockId: originalBlockId,
            outputName,
            fullPath: normalizedPath,
            ...(optional ? { optional: true } : {}),
          }
          outputs.set(normalizedPath, dep)
          deps.push(dep)
        }
      }
    }
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
 * The same dependencies with every output required. For props that
 * resolveTemplateReferences resolves client-side: it substitutes plain
 * `{{ .outputs.X.Y }}` references but can't evaluate `if` or `hasKey`, so a
 * guard there protects nothing.
 */
export function requireAllOutputs(deps: TemplateDependency[]): TemplateDependency[] {
  return deps.map((dep) =>
    dep.type === "output" && dep.optional
      ? { type: dep.type, blockId: dep.blockId, outputName: dep.outputName, fullPath: dep.fullPath }
      : dep,
  )
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
  const seen = new Map<string, TemplateDependency>()

  const collectFromString = (text: string) => {
    const deps = extractTemplateDependenciesFromString(text)
    for (const dep of deps) {
      const key = dep.type === "input" ? `input:${dep.name}` : dep.fullPath
      const existing = seen.get(key)
      if (!existing) {
        seen.set(key, dep)
        allDeps.push(dep)
      } else if (existing.type === "output" && dep.type === "output" && !dep.optional) {
        // One unguarded reference, in any of the strings, makes the output required.
        delete existing.optional
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
