import type { ReactNode } from 'react'
import { normalizeBlockId } from '@/lib/utils'

/**
 * Represents a single output dependency from a template.
 */
export interface OutputDependency {
  /** The block ID that produces the output (e.g., "create-account") - original, not normalized */
  blockId: string
  /** The output name (e.g., "account_id") */
  outputName: string
  /** The full template reference with normalized block ID (e.g., "_blocks.create_account.outputs.account_id") */
  fullPath: string
}

/**
 * Extracts output dependencies from a template by finding {{ ._blocks.blockId.outputs.name }} patterns.
 * 
 * These are references to outputs from other Check/Command blocks that must execute first
 * before this block can run.
 * 
 * Supports various template syntax variations:
 * - {{._blocks.blockId.outputs.name}} (no spaces)
 * - {{ ._blocks.blockId.outputs.name }} (with spaces)
 * - {{ ._blocks.blockId.outputs.name | UpperCase }} (with pipe functions)
 * 
 * @param content - String content to search for dependencies
 * @returns Array of OutputDependency objects found in the template
 */
export function extractOutputDependenciesFromString(content: string): OutputDependency[] {
  const dependencies: OutputDependency[] = []
  const seen = new Set<string>()
  
  // Output dependency regex - matches {{ ._blocks.blockId.outputs.outputName }} patterns
  // 
  // IMPORTANT: Keep in sync with the Go implementation in:
  //   api/boilerplate_config.go (OutputDependencyRegex)
  // 
  // Both implementations are validated against testdata/output-dependency-patterns.json
  // to ensure they produce identical results. Run tests in both languages after any changes.
  //
  // The pattern captures:
  // - blockId: The ID of the block (alphanumeric, hyphens, underscores)
  // - outputName: The output variable name (alphanumeric, underscores)
  const regex = /\{\{\s*\._blocks\.([a-zA-Z0-9_-]+)\.outputs\.(\w+)(?:\s*\|[^}]*)?\s*\}\}/g
  
  let match
  while ((match = regex.exec(content)) !== null) {
    const originalBlockId = match[1]
    const normalizedBlockId = normalizeBlockId(originalBlockId)
    const outputName = match[2]
    // fullPath uses normalized ID for consistent lookups in Go templates
    const fullPath = `_blocks.${normalizedBlockId}.outputs.${outputName}`
    
    // Deduplicate using normalized fullPath
    if (!seen.has(fullPath)) {
      seen.add(fullPath)
      dependencies.push({ 
        blockId: originalBlockId, // Preserve original for display/reference
        outputName, 
        fullPath 
      })
    }
  }
  
  return dependencies
}

/**
 * Extracts output dependencies from React children nodes.
 * 
 * @param children - React children nodes containing the template content
 * @returns Array of OutputDependency objects found in the template
 */
export function extractOutputDependencies(children: ReactNode): OutputDependency[] {
  const allDependencies: OutputDependency[] = []
  const seen = new Set<string>()
  
  const traverse = (node: ReactNode): void => {
    if (typeof node === 'string') {
      const deps = extractOutputDependenciesFromString(node)
      for (const dep of deps) {
        if (!seen.has(dep.fullPath)) {
          seen.add(dep.fullPath)
          allDependencies.push(dep)
        }
      }
    } else if (Array.isArray(node)) {
      node.forEach(traverse)
    } else if (node && typeof node === 'object' && 'props' in node) {
      const element = node as { props?: { children?: ReactNode; value?: string } }
      if (element.props?.value) {
        const deps = extractOutputDependenciesFromString(element.props.value)
        for (const dep of deps) {
          if (!seen.has(dep.fullPath)) {
            seen.add(dep.fullPath)
            allDependencies.push(dep)
          }
        }
      }
      if (element.props?.children) {
        traverse(element.props.children)
      }
    }
  }
  
  traverse(children)
  return allDependencies
}

/**
 * Groups output dependencies by block ID.
 * 
 * @param dependencies - Array of OutputDependency objects
 * @returns Map of blockId to array of output names
 */
export function groupDependenciesByBlock(dependencies: OutputDependency[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  
  for (const dep of dependencies) {
    const existing = grouped.get(dep.blockId) || []
    if (!existing.includes(dep.outputName)) {
      existing.push(dep.outputName)
    }
    grouped.set(dep.blockId, existing)
  }
  
  return grouped
}
