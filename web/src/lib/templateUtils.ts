/**
 * Shared utility functions for template rendering and output dependency tracking.
 * Used by Template, TemplateInline, and useScriptExecution.
 */

import type { BlockOutputs } from '@/contexts/RunbookContext'
import type { OutputDependency } from '@/components/mdx/TemplateInline/lib/extractOutputDependencies'
import { groupDependenciesByBlock } from '@/components/mdx/TemplateInline/lib/extractOutputDependencies'
import { normalizeBlockId } from '@/lib/utils'

export interface UnmetOutputDependency {
  blockId: string
  outputNames: string[]
}

/**
 * Build the _blocks namespace for template rendering.
 * Transforms block outputs into the format expected by boilerplate templates.
 */
export function buildBlocksNamespace(
  allOutputs: Record<string, BlockOutputs>
): Record<string, { outputs: Record<string, string> }> {
  const blocksNamespace: Record<string, { outputs: Record<string, string> }> = {}
  for (const [blockId, data] of Object.entries(allOutputs)) {
    blocksNamespace[blockId] = { outputs: data.values }
  }
  return blocksNamespace
}

/**
 * Compute which output dependencies are not yet satisfied.
 * Groups dependencies by block, normalizes IDs for lookup, and returns
 * the list of blocks/outputs that haven't been produced yet.
 */
export function computeUnmetOutputDependencies(
  outputDependencies: OutputDependency[],
  allOutputs: Record<string, BlockOutputs>
): UnmetOutputDependency[] {
  if (outputDependencies.length === 0) return []

  const byBlock = groupDependenciesByBlock(outputDependencies)
  const unmet: UnmetOutputDependency[] = []

  for (const [blockId, outputNames] of byBlock) {
    const normalizedId = normalizeBlockId(blockId)
    const blockData = allOutputs[normalizedId]

    if (!blockData) {
      // Block hasn't produced any outputs yet - preserve original blockId for display
      unmet.push({ blockId, outputNames })
    } else {
      const missingOutputs = outputNames.filter(name => !(name in blockData.values))
      if (missingOutputs.length > 0) {
        unmet.push({ blockId, outputNames: missingOutputs })
      }
    }
  }

  return unmet
}
