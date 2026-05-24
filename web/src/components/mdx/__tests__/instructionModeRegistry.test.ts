import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MDX_COMPONENTS } from '@/components/MDXContainer'

/**
 * Registry-completeness guard for instruction mode (spec §9/§10).
 *
 * Every interactive block must honor the global instruction-mode flag. This test
 * enumerates the real MDX registry and fails if:
 *  - a block is added without being classified here, or
 *  - a block classified as interactive doesn't actually wire up useInstructionMode.
 *
 * That makes "a block silently forgot the mode" a CI failure rather than a
 * runtime surprise.
 */

// Blocks that flatten to a copy-pasteable instruction when the flag is on.
const INTERACTIVE_BLOCKS = [
  'Command',
  'Check',
  'AwsAuth',
  'GitHubAuth',
  'Template',
  'TemplateInline',
  'GitClone',
  'GitHubPullRequest',
  'DirPicker',
] as const

// Blocks intentionally identical in both modes:
// - Inputs is the user's way to supply substitution values (spec §6.5.1).
// - Admonition is already a static callout.
const PASSTHROUGH_BLOCKS = ['Inputs', 'Admonition'] as const

// Non-block element overrides (not runbook blocks).
const ELEMENT_OVERRIDES = ['a', 'pre'] as const

describe('instruction mode — MDX registry coverage', () => {
  it('every registry entry is classified (a new block forces a decision)', () => {
    const known = new Set<string>([
      ...INTERACTIVE_BLOCKS,
      ...PASSTHROUGH_BLOCKS,
      ...ELEMENT_OVERRIDES,
    ])
    const registryKeys = Object.keys(MDX_COMPONENTS)
    const unclassified = registryKeys.filter((k) => !known.has(k))
    expect(unclassified).toEqual([])
  })

  it('every classified block is present in the registry', () => {
    const registryKeys = new Set(Object.keys(MDX_COMPONENTS))
    for (const name of [...INTERACTIVE_BLOCKS, ...PASSTHROUGH_BLOCKS, ...ELEMENT_OVERRIDES]) {
      expect(registryKeys.has(name)).toBe(true)
    }
  })

  it.each(INTERACTIVE_BLOCKS)('%s wires up useInstructionMode', (block) => {
    const source = readFileSync(
      resolve(process.cwd(), `src/components/mdx/${block}/${block}.tsx`),
      'utf8',
    )
    expect(source).toContain('useInstructionMode')
  })
})
