import type { ReactNode } from 'react'

/**
 * Represents a single output dependency from a template.
 */
export interface OutputDependency {
  /** The block ID that produces the output (e.g., "create-account") */
  blockId: string
  /** The output name (e.g., "account_id") */
  outputName: string
  /** The full template reference (e.g., "_blocks.create-account.outputs.account_id") */
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
  
  // Match {{ ._blocks.blockId.outputs.outputName }} patterns
  // The pattern captures:
  // - blockId: The ID of the block (alphanumeric, hyphens, underscores)
  // - outputName: The output variable name (alphanumeric, underscores)
  const regex = /\{\{\s*\._blocks\.([a-zA-Z0-9_-]+)\.outputs\.(\w+)(?:\s*\|[^}]*)?\s*\}\}/g
  
  let match
  while ((match = regex.exec(content)) !== null) {
    const blockId = match[1]
    const outputName = match[2]
    const fullPath = `_blocks.${blockId}.outputs.${outputName}`
    
    // Deduplicate
    if (!seen.has(fullPath)) {
      seen.add(fullPath)
      dependencies.push({ blockId, outputName, fullPath })
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
