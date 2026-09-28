import { describe, it, expect } from 'vitest'
import { MDX_COMPONENTS } from '@/components/MDXContainer'
import { BLOCK_TYPES } from '../../../../../cli/test/blockTypes.ts'

/**
 * Test-runner guard for the MDX block registry.
 *
 * `runbooks test` (cli/) can't import the React registry, so it keeps its own
 * list of block types. This fails when the two drift apart, so a block can't
 * ship while every runbook that uses it fails its tests with "Unknown block
 * type", and the runner can't keep a block the app no longer registers.
 */

// Non-block element overrides (not runbook blocks).
const ELEMENT_OVERRIDES = new Set(['a', 'pre', 'input'])

const blockNames = Object.keys(MDX_COMPONENTS).filter((name) => !ELEMENT_OVERRIDES.has(name))
const cliBlockTypes: readonly string[] = BLOCK_TYPES

describe('test CLI coverage — MDX block registry', () => {
  it.each(blockNames)('runbooks test knows <%s>', (name) => {
    expect(
      cliBlockTypes,
      `Add "${name}" to BLOCK_TYPES in cli/test/blockTypes.ts, and teach cli/test/executor.ts to run it`,
    ).toContain(name)
  })

  it('runbooks test knows no block the app does not register', () => {
    expect(cliBlockTypes.filter((name) => !blockNames.includes(name))).toEqual([])
  })
})
