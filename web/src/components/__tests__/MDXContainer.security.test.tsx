import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

  // Front matter is stripped before compiling; the error must still name the
  // line in the runbook file, not the line after stripping.
  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('names the runbook file line when there is front matter (%s)', async (_name, eol) => {
    const content = [
      '---',
      'title: Front matter',
      '---',
      '',
      '# Title',
      '',
      '<Command id="a" command={run()} />',
    ].join(eol)

    render(
      <TestWrapper>
        <MDXContainer content={content} runbookPath="testdata/demo/front-matter" />
      </TestWrapper>,
    )

    const error = await screen.findByTestId('mdx-error')
    expect(error).toHaveTextContent('Line 7: the `command` prop of <Command> must be a literal value')
    expect(invoke).not.toHaveBeenCalled()
  })
})

// Every runbook we ship as test data or as an e2e fixture must stay within the
// literal-only rules.
const REPO_ROOT = resolve(process.cwd(), '..')
const RUNBOOK_DIRS = ['testdata', join('test', 'fixtures', 'runbooks')]

const runbooksIn = (dir: string) =>
  readdirSync(resolve(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.mdx'))
    .map((file) => join(dir, file))
    .sort()

describe('compileMDX — shipped runbooks', () => {
  it.each(RUNBOOK_DIRS)('finds the runbooks under %s', (dir) => {
    expect(runbooksIn(dir).length).toBeGreaterThan(0)
  })

  it.each(RUNBOOK_DIRS.flatMap(runbooksIn))('compiles %s', async (file) => {
    const content = readFileSync(resolve(REPO_ROOT, file), 'utf8')
    await expect(compileMDX(content)).resolves.toBeTypeOf('function')
  })
})
