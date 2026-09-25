import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TestWrapper } from '@/test/test-utils'
import MDXContainer, { compileMDX } from '@/components/MDXContainer'

/**
 * Runbook MDX is compiled and evaluated in the renderer, where `window.api`
 * can run any registered script. These tests pin that a runbook cannot reach
 * it just by being opened: ESM and non-literal expressions are rejected at
 * compile time, before any of the runbook's code runs.
 */

const EXEC = `window.api.invoke('exec:run', { executableId: 'abc' })`

const ATTACKS: Array<[string, string]> = [
  ['an export', `export const _ = ${EXEC}\n\n# Title`],
  ['an import', `import x from "data:text/javascript,${encodeURIComponent(`${EXEC}; export default 1`)}"\n\n# Title`],
  ['a call expression', `# Title\n\n{${EXEC}}`],
  ['a text expression', `Hello {String(${EXEC})} there`],
  ['a prop expression', `<Admonition type="info" title={String(${EXEC})} />`],
  ['a spread prop', `<Admonition type="info" {...${EXEC}} />`],
  ['a template substitution', `<Admonition type="info" title={\`\${${EXEC}}\`} />`],
]

describe('MDXContainer — runbook code cannot run on open', () => {
  const invoke = vi.fn()
  const originalApi = window.api

  beforeEach(() => {
    invoke.mockReset()
    window.api = { invoke, on: vi.fn(() => () => {}), once: vi.fn() } as unknown as typeof window.api
  })

  afterEach(() => {
    window.api = originalApi
  })

  it.each(ATTACKS)('rejects %s and never calls the API', async (_name, content) => {
    render(
      <TestWrapper>
        <MDXContainer content={content} runbookPath="testdata/demo/attack" />
      </TestWrapper>,
    )

    const error = await screen.findByTestId('mdx-error')
    expect(error).toHaveTextContent('Error processing MDX content')
    expect(error).toHaveTextContent(/not allowed in runbooks|must be a literal value/)
    expect(screen.queryByTestId('runbook-content')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('still renders literal props, comments and template strings', async () => {
    const content = [
      '# Literal props',
      '',
      '{/* an author comment */}',
      '',
      "<Admonition type=\"info\" title={'Literal title'} description={`No substitutions here`} />",
    ].join('\n')

    render(
      <TestWrapper>
        <MDXContainer content={content} runbookPath="testdata/demo/literal" />
      </TestWrapper>,
    )

    expect(await screen.findByText('Literal title')).toBeInTheDocument()
    expect(screen.getByText('No substitutions here')).toBeInTheDocument()
    expect(screen.queryByTestId('mdx-error')).toBeNull()
  })
})

// Every runbook we ship as test data must stay within the literal-only rules.
const TESTDATA_DIR = resolve(process.cwd(), '../testdata')
const testdataRunbooks = readdirSync(TESTDATA_DIR, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.mdx'))
  .sort()

describe('compileMDX — testdata runbooks', () => {
  it('finds the testdata runbooks', () => {
    expect(testdataRunbooks.length).toBeGreaterThan(0)
  })

  it.each(testdataRunbooks)('compiles %s', async (file) => {
    const content = readFileSync(resolve(TESTDATA_DIR, file), 'utf8')
    await expect(compileMDX(content)).resolves.toBeTypeOf('function')
  })
})
