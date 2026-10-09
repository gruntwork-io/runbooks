/**
 * Template dependency extraction for {{ .inputs.X }} / {{ .outputs.X.Y }} syntax.
 *
 * The parser is shared with main (src/domain/boilerplate/templateDependencies.ts),
 * which uses it to gate a Template block on the outputs its files read. This
 * module adds what only the renderer needs: walking React children, and
 * splitting dependencies for computeUnmetInputDependencies and
 * computeUnmetOutputDependencies.
 *
 * Used by useTemplateDependencies hook and any block that needs to discover what
 * template expressions its props/content contain.
 */

import type { ReactNode } from "react"
import type { InputName } from "@/lib/templateUtils"
import {
  extractTemplateDependenciesFromString,
  type TemplateDependency,
} from "../../../src/domain/boilerplate/templateDependencies"

export { extractTemplateDependenciesFromString, type TemplateDependency }

// OutputDependency is defined canonically alongside the boilerplate config types.
// Import it for local use below, and re-export so existing importers keep a
// single source of truth. (BlockId/OutputName are string aliases, so the shapes
// are identical.)
import type { OutputDependency } from "@/types/boilerplateConfig"
export type { OutputDependency }

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
 * feeds them to extractTemplateDependenciesFromString, each as its own template.
 *
 * Used by TemplateInline where template content arrives as React children,
 * not as a string prop.
 *
 * @param children - React children nodes containing template content
 * @returns Array of TemplateDependency objects found in the template
 */
export function extractTemplateDependencies(children: ReactNode): TemplateDependency[] {
  const texts: string[] = []

  const traverse = (node: ReactNode): void => {
    if (typeof node === "string") {
      texts.push(node)
    } else if (Array.isArray(node)) {
      node.forEach(traverse)
    } else if (node && typeof node === "object" && "props" in node) {
      const element = node as { props?: { children?: ReactNode; value?: string } }
      if (element.props?.value) {
        texts.push(element.props.value)
      }
      if (element.props?.children) {
        traverse(element.props.children)
      }
    }
  }

  traverse(children)
  return extractTemplateDependenciesFromString(...texts)
}
