import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MDX_COMPONENTS } from '@/components/MDXContainer'

/**
 * Docs-completeness guard for the blocks reference (docs/.../authoring/blocks).
 *
 * Enumerates the real MDX registry and fails if an enabled block has no docs
 * page, no matching `title:` frontmatter, or isn't linked from the blocks
 * index — so "shipped a block but forgot the docs" is a CI failure rather
 * than a support question.
 */

// Non-block element overrides (not runbook blocks) — no docs page expected.
const ELEMENT_OVERRIDES = new Set(['a', 'pre', 'input'])

const BLOCKS_DOCS_DIR = resolve(process.cwd(), '../docs/src/content/docs/authoring/blocks')

const blockNames = Object.keys(MDX_COMPONENTS).filter((name) => !ELEMENT_OVERRIDES.has(name))

const docsPathFor = (name: string): string | undefined => {
  const mdx = resolve(BLOCKS_DOCS_DIR, `${name}.mdx`)
  const md = resolve(BLOCKS_DOCS_DIR, `${name}.md`)
  if (existsSync(mdx)) return mdx
  if (existsSync(md)) return md
  return undefined
}

describe('docs coverage — MDX block registry', () => {
  it.each(blockNames)('%s has a docs page under authoring/blocks', (name) => {
    expect(
      docsPathFor(name),
      `Expected a docs page for <${name}> at docs/src/content/docs/authoring/blocks/${name}.mdx (or .md)`,
    ).toBeDefined()
  })

  it.each(blockNames)('%s docs page declares a matching title', (name) => {
    const path = docsPathFor(name)
    if (!path) return // already reported by the previous test

    const source = readFileSync(path, 'utf8')
    expect(source).toMatch(new RegExp(`^title:\\s*<${name}>\\s*$`, 'm'))
  })

  it('every block is linked from the blocks index', () => {
    const index = readFileSync(resolve(BLOCKS_DOCS_DIR, 'index.md'), 'utf8')
    const missing = blockNames.filter(
      (name) => !index.includes(`(/authoring/blocks/${name.toLowerCase()})`),
    )
    expect(missing).toEqual([])
  })
})
