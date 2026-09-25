import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import DirPicker from '../DirPicker'
import type { DirPickerProps } from '../types'
import { TestWrapper } from '@/test/test-utils'
import { ApiProvider, type RunbooksAPI } from '@/contexts/ApiContext'
import { useRunbookContext } from '@/contexts/useRunbook'
import { useInstructionMode } from '@/contexts/useInstructionMode'
import { INSTRUCTION_MODE_STORAGE_KEY } from '@/contexts/InstructionModeContext.types'

// Mock useSession
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({
    isReady: true,
  }),
}))

/** Directory tree served by the `workspace:dirs` stub, keyed by absolute path. */
const TREE: Record<string, string[]> = {
  '/root': ['dev', 'prod'],
  '/root/dev': ['sandbox'],
  '/root/prod': ['us-east-1', 'us-west-2'],
  '/root/prod/us-east-1': ['svc'],
  '/root2': ['alpha'],
}

type DirsResult = { dirs: string[] }

/**
 * IPC stub that answers `workspace:dirs` from TREE, in the `{ dirs }` shape the
 * channel declares. `pending` lets a test hold a single path's response open.
 */
function makeApi(pending: Record<string, Promise<DirsResult>> = {}) {
  const invoke = vi.fn(async (channel: string, params?: { worktreePath: string }) => {
    if (channel === 'workspace:dirs') {
      const worktreePath = params!.worktreePath
      return pending[worktreePath] ?? { dirs: TREE[worktreePath] ?? [] }
    }
    if (channel === 'native:set-theme') return { ok: true }
    throw new Error(`unexpected channel: ${channel}`)
  })
  const api = { invoke, on: () => () => {}, once: () => {} } as unknown as RunbooksAPI
  return { api, invoke }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

/** Prints the `dp` block's registered output values so tests can read them. */
function PublishedOutputs() {
  const { blockOutputs } = useRunbookContext()
  return <pre data-testid="dp-outputs">{JSON.stringify(blockOutputs.dp?.values ?? null)}</pre>
}

const publishedValues = () => JSON.parse(screen.getByTestId('dp-outputs').textContent!)

/** Registers a GitClone-style `clone_path` output for block `clone`. */
function CloneOutput({ clonePath }: { clonePath: string }) {
  const { registerOutputs } = useRunbookContext()
  useEffect(() => {
    registerOutputs('clone', { clone_path: clonePath })
  }, [clonePath, registerOutputs])
  return null
}

function InstructionModeToggle() {
  const { enabled, setEnabled } = useInstructionMode()
  return <button onClick={() => setEnabled(!enabled)}>toggle instruction mode</button>
}

function Harness({ api, children }: { api: RunbooksAPI; children: ReactNode }) {
  return (
    <ApiProvider api={api}>
      <TestWrapper>
        {children}
        <PublishedOutputs />
      </TestWrapper>
    </ApiProvider>
  )
}

const selects = () => screen.getAllByRole('combobox') as HTMLSelectElement[]
const optionValues = (select: HTMLSelectElement) =>
  Array.from(select.options).map(o => o.value).filter(Boolean)
const pathInput = () => screen.getByRole('textbox') as HTMLInputElement

/** Render a rootDir-backed picker and wait for the root dropdown to fill. */
async function renderPicker(props: Partial<DirPickerProps> = {}, api = makeApi().api) {
  render(
    <Harness api={api}>
      <DirPicker id="dp" rootDir="/root" dirLabels={['Env', 'Region']} {...props} />
    </Harness>,
  )
  await waitFor(() => expect(optionValues(selects()[0])).toEqual(['dev', 'prod']))
}

async function select(levelIndex: number, value: string) {
  await act(async () => {
    fireEvent.change(selects()[levelIndex], { target: { value } })
  })
}

describe('DirPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders without crashing when dirLabels is omitted', async () => {
    // Regression guard: dirLabels was a required prop dereferenced via
    // `dirLabels.length`, so omitting it crashed the block at render.
    render(
      <Harness api={makeApi().api}>
        <DirPicker id="test-picker" rootDir="/root" />
      </Harness>
    )

    expect(screen.getByTestId('test-picker')).toBeDefined()
    expect(screen.queryByText(/requires either a/)).toBeNull()
    // Without dirLabels, levels fall back to "Level N" labels.
    expect(await screen.findByText('Level 1')).toBeDefined()
  })

  it('renders title and description', () => {
    render(
      <TestWrapper>
        <DirPicker id="test-picker" dirLabels={['Environment', 'Region']} title="Pick a dir" description="Choose wisely" />
      </TestWrapper>
    )

    expect(screen.getByText('Pick a dir')).toBeDefined()
    expect(screen.getByText('Choose wisely')).toBeDefined()
  })

  it('renders with default title and description', () => {
    render(
      <TestWrapper>
        <DirPicker id="test-picker" dirLabels={['Environment', 'Region']} />
      </TestWrapper>
    )

    expect(screen.getByText('Select Directory')).toBeDefined()
    expect(screen.getByText('Choose a target directory')).toBeDefined()
  })

  it('shows unmet dependency warning when gitCloneId outputs are not yet available', () => {
    render(
      <TestWrapper>
        <DirPicker id="test-picker" dirLabels={['Environment', 'Region']} gitCloneId="clone-repo" />
      </TestWrapper>
    )

    // Shows the block ID in a code badge and a helpful message
    expect(screen.getByText('clone-repo')).toBeDefined()
    expect(screen.getByText('Complete the GitClone block above to browse directories.')).toBeDefined()
  })

  it('shows error when neither rootDir nor gitCloneId is provided', () => {
    render(
      <TestWrapper>
        <DirPicker id="test-picker" dirLabels={['Environment', 'Region']} />
      </TestWrapper>
    )

    expect(screen.getByText(/requires either a/)).toBeDefined()
    expect(screen.queryByText('Complete the GitClone block above to browse directories.')).toBeNull()
  })

  it('renders without waiting state when rootDir is provided', async () => {
    await renderPicker()

    // Should not show waiting message or missing-config error
    expect(screen.queryByText('Complete the GitClone block above to browse directories.')).toBeNull()
    expect(screen.queryByText(/requires either a/)).toBeNull()
  })

  it('renders custom pathLabel', async () => {
    await renderPicker({ pathLabel: 'Deployment Path' })

    expect(screen.getByText('Deployment Path')).toBeDefined()
    expect(screen.queryByText('Target Path')).toBeNull()
  })
})

describe('DirPicker — cascading dropdowns', () => {
  it('fills the root dropdown from workspace:dirs and adds a level for the selected directory', async () => {
    const { api, invoke } = makeApi()
    await renderPicker({}, api)
    expect(invoke).toHaveBeenCalledWith('workspace:dirs', { worktreePath: '/root' })

    await select(0, 'prod')

    await waitFor(() => expect(selects()).toHaveLength(2))
    expect(invoke).toHaveBeenCalledWith('workspace:dirs', { worktreePath: '/root/prod' })
    expect(optionValues(selects()[1])).toEqual(['us-east-1', 'us-west-2'])
    expect(screen.getByText('Region')).toBeDefined()
  })

  it('stops at dirLabels.length levels unless dirLabelsExtra is set', async () => {
    const { api, invoke } = makeApi()
    await renderPicker({}, api)
    await select(0, 'prod')
    await waitFor(() => expect(selects()).toHaveLength(2))

    await select(1, 'us-east-1')

    expect(selects()).toHaveLength(2)
    expect(invoke).not.toHaveBeenCalledWith('workspace:dirs', { worktreePath: '/root/prod/us-east-1' })
  })

  it('drills past dirLabels.length with dirLabelsExtra, labelling extra levels "Level N"', async () => {
    await renderPicker({ dirLabelsExtra: true })
    await select(0, 'prod')
    await waitFor(() => expect(selects()).toHaveLength(2))

    await select(1, 'us-east-1')

    await waitFor(() => expect(selects()).toHaveLength(3))
    expect(optionValues(selects()[2])).toEqual(['svc'])
    expect(screen.getByText('Level 3')).toBeDefined()
  })

  it('discards a slow fetch for a selection the user has since changed', async () => {
    const prodFetch = deferred<DirsResult>()
    await renderPicker({}, makeApi({ '/root/prod': prodFetch.promise }).api)

    await select(0, 'prod')
    await select(0, 'dev')
    await waitFor(() => expect(selects()).toHaveLength(2))
    expect(optionValues(selects()[1])).toEqual(['sandbox'])

    await act(async () => {
      prodFetch.resolve({ dirs: TREE['/root/prod'] })
    })

    expect(selects()).toHaveLength(2)
    expect(optionValues(selects()[1])).toEqual(['sandbox'])
  })
})

describe('DirPicker — PATH output', () => {
  afterEach(() => {
    localStorage.removeItem(INSTRUCTION_MODE_STORAGE_KEY)
  })

  it('publishes the composed dropdown path', async () => {
    await renderPicker()
    await select(0, 'prod')
    await waitFor(() => expect(selects()).toHaveLength(2))
    await select(1, 'us-east-1')

    await waitFor(() => expect(publishedValues()).toEqual({ PATH: 'prod/us-east-1' }))
    expect(pathInput().value).toBe('prod/us-east-1')
  })

  it('publishes a manually edited path', async () => {
    await renderPicker()
    await select(0, 'prod')
    await waitFor(() => expect(publishedValues()).toEqual({ PATH: 'prod' }))

    fireEvent.change(pathInput(), { target: { value: 'custom/path' } })

    await waitFor(() => expect(publishedValues()).toEqual({ PATH: 'custom/path' }))
  })

  it('removes PATH when the root dropdown is reset to its placeholder', async () => {
    await renderPicker()
    await select(0, 'prod')
    await waitFor(() => expect(publishedValues()).toEqual({ PATH: 'prod' }))

    await select(0, '')

    expect(pathInput().value).toBe('')
    await waitFor(() => expect(publishedValues()).toEqual({}))
  })

  it('removes PATH when a manually typed path is cleared', async () => {
    await renderPicker()
    fireEvent.change(pathInput(), { target: { value: 'typed' } })
    await waitFor(() => expect(publishedValues()).toEqual({ PATH: 'typed' }))

    fireEvent.change(pathInput(), { target: { value: '' } })

    await waitFor(() => expect(publishedValues()).toEqual({}))
  })

  it('removes PATH when the GitClone root changes and the dropdowns reset', async () => {
    const { api } = makeApi()
    const picker = <DirPicker id="dp" gitCloneId="clone" dirLabels={['Env', 'Region']} />
    const { rerender } = render(
      <Harness api={api}>
        <CloneOutput clonePath="/root" />
        {picker}
      </Harness>,
    )
    await waitFor(() => expect(optionValues(selects()[0])).toEqual(['dev', 'prod']))
    await select(0, 'prod')
    await waitFor(() => expect(publishedValues()).toEqual({ PATH: 'prod' }))

    rerender(
      <Harness api={api}>
        <CloneOutput clonePath="/root2" />
        {picker}
      </Harness>,
    )

    await waitFor(() => expect(optionValues(selects()[0])).toEqual(['alpha']))
    await waitFor(() => expect(publishedValues()).toEqual({}))
  })

  it('publishes no PATH for an empty field in instruction mode', async () => {
    localStorage.setItem(INSTRUCTION_MODE_STORAGE_KEY, 'true')
    render(
      <Harness api={makeApi().api}>
        <DirPicker id="dp" rootDir="/root" dirLabels={['Env', 'Region']} />
      </Harness>,
    )
    // An entry with no PATH, not a missing entry or PATH: ''.
    expect(publishedValues()).toEqual({})

    fireEvent.change(pathInput(), { target: { value: 'prod' } })
    await waitFor(() => expect(publishedValues()).toEqual({ PATH: 'prod' }))

    fireEvent.change(pathInput(), { target: { value: '' } })
    await waitFor(() => expect(publishedValues()).toEqual({}))
  })

  it('removes a PATH typed in instruction mode when switching back to the interactive picker', async () => {
    localStorage.setItem(INSTRUCTION_MODE_STORAGE_KEY, 'true')
    render(
      <Harness api={makeApi().api}>
        <InstructionModeToggle />
        <DirPicker id="dp" rootDir="/root" dirLabels={['Env', 'Region']} />
      </Harness>,
    )
    fireEvent.change(pathInput(), { target: { value: 'typed-in-instruction' } })
    await waitFor(() => expect(publishedValues()).toEqual({ PATH: 'typed-in-instruction' }))

    fireEvent.click(screen.getByText('toggle instruction mode'))

    // The interactive picker starts with an empty path, so the published PATH
    // must go too rather than keep pointing at the instruction-mode value.
    await waitFor(() => expect(optionValues(selects()[0])).toEqual(['dev', 'prod']))
    expect(pathInput().value).toBe('')
    await waitFor(() => expect(publishedValues()).toEqual({}))
  })
})
