import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ApiProvider, type RunbooksAPI } from '@/contexts/ApiContext'
import { IpcGitWorkTreeProvider } from '@/contexts/IpcGitWorkTreeContext'
import { WorkspaceGitDataProvider } from '@/contexts/WorkspaceGitDataContext'
import { useGitWorkTree } from '@/contexts/useGitWorkTree'
import type { GitWorkTree, GitWorkTreeContextType } from '@/contexts/gitWorkTreeTypes'
import { useGitFileChanges, type WorkspaceFileChange } from '@/hooks/useGitFileChanges'
import { useGitFileTree, type WorkspaceTreeNode } from '@/hooks/useGitFileTree'
import { Workspace } from '@/components/artifacts/workspace/Workspace'

// The IPC bridge is the only fake. `workspace:changes` and `workspace:tree`
// calls stay pending until a test settles them, so each test decides the order
// in which responses land.
interface PendingCall {
  channel: string
  params: { worktreePath: string; singleFile?: string }
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

function createApi() {
  const calls: PendingCall[] = []
  const invoke = vi.fn((channel: string, params: PendingCall['params']) => {
    if (channel === 'workspace:changes' || channel === 'workspace:tree') {
      return new Promise((resolve, reject) => {
        calls.push({ channel, params, resolve, reject })
      })
    }
    return Promise.resolve({ ok: true })
  })
  const api = { invoke, on: vi.fn(() => () => {}), once: vi.fn() } as unknown as RunbooksAPI
  const callsTo = (channel: string, worktreePath?: string) =>
    calls.filter(c => c.channel === channel && (worktreePath === undefined || c.params.worktreePath === worktreePath))
  return { api, callsTo }
}

function Providers({ api, children }: { api: RunbooksAPI; children: ReactNode }) {
  return (
    <ApiProvider api={api}>
      <IpcGitWorkTreeProvider>
        <WorkspaceGitDataProvider>{children}</WorkspaceGitDataProvider>
      </IpcGitWorkTreeProvider>
    </ApiProvider>
  )
}

function renderWorkspaceData(api: RunbooksAPI) {
  return renderHook(
    () => ({ workTrees: useGitWorkTree(), changes: useGitFileChanges(), tree: useGitFileTree() }),
    { wrapper: ({ children }) => <Providers api={api}>{children}</Providers> },
  )
}

const worktree = (name: string): GitWorkTree => ({
  id: name,
  repoUrl: `https://github.com/acme/${name}`,
  localPath: `/repos/${name}`,
  gitInfo: { repoUrl: `https://github.com/acme/${name}`, repoName: name, repoOwner: 'acme', ref: 'main' },
})

const modified = (path: string, extra: Partial<WorkspaceFileChange> = {}): WorkspaceFileChange => ({
  path,
  changeType: 'modified',
  additions: 1,
  deletions: 1,
  language: 'hcl',
  ...extra,
})

const file = (id: string): WorkspaceTreeNode => ({ id, name: id, type: 'file' })
const lazyFolder = (id: string): WorkspaceTreeNode => ({ id, name: id, type: 'folder', isLazyLoad: true })

/** Settle every pending call in `calls` with `value`, flushing React updates. */
async function settle(calls: PendingCall[], value: unknown) {
  await act(async () => {
    for (const call of calls) call.resolve(value)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WorkspaceGitDataProvider', () => {
  it("shares one changes poll and one tree fetch between App's two Workspace panels and a PR block", async () => {
    const { api, callsTo } = createApi()
    let workTrees!: GitWorkTreeContextType
    function CaptureWorkTrees() {
      workTrees = useGitWorkTree()
      return null
    }
    function PrBlockChanges() {
      const { changes } = useGitFileChanges()
      return <div data-testid="pr-block">{changes.map(c => c.path).join(',')}</div>
    }

    render(
      <Providers api={api}>
        <CaptureWorkTrees />
        {/* App mounts a desktop and a mobile ArtifactsContainer at once */}
        <Workspace generatedFiles={[]} />
        <Workspace generatedFiles={[]} />
        <PrBlockChanges />
      </Providers>,
    )

    await act(async () => {
      workTrees.registerWorkTree(worktree('a'))
    })
    // Both Workspaces open on "All files", which mounts a RepositoryFileBrowser
    // (another changes reader) in each of them.
    expect(screen.getAllByTestId('filetree-all')).toHaveLength(2)
    expect(callsTo('workspace:changes')).toHaveLength(1)
    expect(callsTo('workspace:tree')).toHaveLength(1)

    await settle(callsTo('workspace:tree'), { tree: [file('main.tf')], totalFiles: 1 })
    await settle(callsTo('workspace:changes'), { changes: [modified('main.tf')], totalChanges: 1 })
    expect(screen.getByTestId('pr-block')).toHaveTextContent('main.tf')
    // The change count moving 0 -> 1 refreshes the tree once, not once per Workspace
    expect(callsTo('workspace:tree')).toHaveLength(2)

    for (const expected of [2, 3]) {
      await act(async () => {
        vi.advanceTimersByTime(3000)
      })
      expect(callsTo('workspace:changes')).toHaveLength(expected)
      await settle(callsTo('workspace:changes').slice(-1), { changes: [modified('main.tf')], totalChanges: 1 })
    }
  })

  it("keeps the active worktree's tree when the previous worktree's walk lands after it", async () => {
    const { api, callsTo } = createApi()
    const { result } = renderWorkspaceData(api)

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('a'))
    })
    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('b'))
    })
    await act(async () => {
      result.current.workTrees.setActiveWorkTree('b')
    })
    const [staleA, ...laterA] = callsTo('workspace:tree', '/repos/a')
    expect(callsTo('workspace:tree', '/repos/b')).toHaveLength(1)

    // A stale walk landing first neither shows A's files nor ends B's spinner
    await settle([staleA], { tree: [file('a-file')], totalFiles: 1 })
    expect(result.current.tree.tree).toBeNull()
    expect(result.current.tree.isLoading).toBe(true)

    await settle(callsTo('workspace:tree', '/repos/b'), { tree: [file('b-file')], totalFiles: 1 })
    await settle(laterA, { tree: [file('a-file')], totalFiles: 1 })
    expect(result.current.tree.tree?.map(n => n.id)).toEqual(['b-file'])
    expect(result.current.tree.isLoading).toBe(false)
  })

  it("does not show an error from the previous worktree's failed tree walk", async () => {
    const { api, callsTo } = createApi()
    const { result } = renderWorkspaceData(api)

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('a'))
    })
    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('b'))
    })
    await act(async () => {
      result.current.workTrees.setActiveWorkTree('b')
    })

    await act(async () => {
      for (const call of callsTo('workspace:tree', '/repos/a')) call.reject(new Error('EACCES'))
    })
    expect(result.current.tree.error).toBeNull()
    expect(result.current.tree.isLoading).toBe(true)

    await settle(callsTo('workspace:tree', '/repos/b'), { tree: [file('b-file')], totalFiles: 1 })
    expect(result.current.tree.error).toBeNull()
    expect(result.current.tree.tree?.map(n => n.id)).toEqual(['b-file'])
  })

  it('refetches changes immediately when the tree is invalidated mid-poll, and drops the older response', async () => {
    const { api, callsTo } = createApi()
    const { result } = renderWorkspaceData(api)

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('a'))
    })
    const [beforeWrite] = callsTo('workspace:changes')

    await act(async () => {
      result.current.workTrees.invalidateGitFileTree()
    })
    const pending = callsTo('workspace:changes')
    expect(pending).toHaveLength(2)

    await settle([pending[1]], { changes: [modified('written-by-script.tf')], totalChanges: 1 })
    await settle([beforeWrite], { changes: [], totalChanges: 0 })
    expect(result.current.changes.changes.map(c => c.path)).toEqual(['written-by-script.tf'])
    expect(result.current.changes.totalChanges).toBe(1)
    expect(result.current.changes.isLoading).toBe(false)
  })

  it('skips an interval tick while the previous poll is still running', async () => {
    const { api, callsTo } = createApi()
    const { result } = renderWorkspaceData(api)

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('a'))
    })
    expect(callsTo('workspace:changes')).toHaveLength(1)

    // A slow repo: git status outlasts two poll intervals
    await act(async () => {
      vi.advanceTimersByTime(6000)
    })
    expect(callsTo('workspace:changes')).toHaveLength(1)

    await settle(callsTo('workspace:changes'), { changes: [], totalChanges: 0 })
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(callsTo('workspace:changes')).toHaveLength(2)
  })

  it('keeps the changes spinner until the current poll lands, not a superseded one', async () => {
    const { api, callsTo } = createApi()
    const { result } = renderWorkspaceData(api)

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('a'))
    })
    const [beforeWrite] = callsTo('workspace:changes')
    await act(async () => {
      result.current.workTrees.invalidateGitFileTree()
    })
    const [, current] = callsTo('workspace:changes')

    await settle([beforeWrite], { changes: [], totalChanges: 0 })
    expect(result.current.changes.isLoading).toBe(true)

    await settle([current], { changes: [modified('written-by-script.tf')], totalChanges: 1 })
    expect(result.current.changes.isLoading).toBe(false)
  })

  it("polls the new worktree right after a switch and drops the old worktree's late response", async () => {
    const { api, callsTo } = createApi()
    const { result } = renderWorkspaceData(api)

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('a'))
      result.current.workTrees.registerWorkTree(worktree('b'))
    })
    await act(async () => {
      result.current.workTrees.setActiveWorkTree('b')
    })
    expect(callsTo('workspace:changes', '/repos/b')).toHaveLength(1)

    await settle(callsTo('workspace:changes', '/repos/b'), { changes: [modified('b.tf')], totalChanges: 1 })
    await settle(callsTo('workspace:changes', '/repos/a'), { changes: [modified('a.tf'), modified('a2.tf')], totalChanges: 2 })
    expect(result.current.changes.changes.map(c => c.path)).toEqual(['b.tf'])
    expect(result.current.changes.totalChanges).toBe(1)
    expect(result.current.changes.isLoading).toBe(false)
  })

  it("does not merge a full diff loaded for the previous worktree into the new one's changes", async () => {
    const { api, callsTo } = createApi()
    const { result } = renderWorkspaceData(api)

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('a'))
    })
    await settle(callsTo('workspace:changes'), { changes: [modified('main.tf', { diffTruncated: true })], totalChanges: 1 })

    let diffLoaded!: Promise<void>
    await act(async () => {
      diffLoaded = result.current.changes.fetchFileDiff('main.tf')
    })
    const [diffForA] = callsTo('workspace:changes').filter(c => c.params.singleFile === 'main.tf')

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('b'))
    })
    await act(async () => {
      result.current.workTrees.setActiveWorkTree('b')
    })
    await settle(callsTo('workspace:changes', '/repos/b'), { changes: [modified('main.tf', { diffTruncated: true })], totalChanges: 1 })

    await settle([diffForA], { changes: [modified('main.tf', { originalContent: 'a-old', newContent: 'a-new' })], totalChanges: 1 })
    await diffLoaded
    expect(result.current.changes.changes).toEqual([modified('main.tf', { diffTruncated: true })])
  })

  it("does not graft the previous worktree's lazy-folder children onto the new tree", async () => {
    const { api, callsTo } = createApi()
    const { result } = renderWorkspaceData(api)

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('a'))
    })
    await settle(callsTo('workspace:tree'), { tree: [lazyFolder('node_modules')], totalFiles: 0 })

    await act(async () => {
      void result.current.tree.fetchSubtree('node_modules')
    })
    const [subtreeOfA] = callsTo('workspace:tree', '/repos/a/node_modules')

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('b'))
    })
    await act(async () => {
      result.current.workTrees.setActiveWorkTree('b')
    })
    await settle(callsTo('workspace:tree', '/repos/b'), { tree: [lazyFolder('node_modules')], totalFiles: 0 })

    await settle([subtreeOfA], { tree: [file('left-pad')], totalFiles: 1 })
    expect(result.current.tree.tree).toEqual([lazyFolder('node_modules')])
  })

  it("merges a lazy folder's children after a background refresh of the same worktree", async () => {
    const { api, callsTo } = createApi()
    const { result } = renderWorkspaceData(api)

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('a'))
    })
    await settle(callsTo('workspace:tree'), { tree: [lazyFolder('node_modules')], totalFiles: 0 })

    await act(async () => {
      void result.current.tree.fetchSubtree('node_modules')
    })
    const [subtree] = callsTo('workspace:tree', '/repos/a/node_modules')

    await act(async () => {
      result.current.workTrees.invalidateGitFileTree()
    })
    await settle(callsTo('workspace:tree', '/repos/a').slice(-1), { tree: [lazyFolder('node_modules')], totalFiles: 0 })

    await settle([subtree], { tree: [file('left-pad')], totalFiles: 1 })
    expect(result.current.tree.tree?.[0]).toMatchObject({
      id: 'node_modules',
      isLazyLoad: false,
      children: [{ id: 'node_modules/left-pad' }],
    })
  })

  it('drops responses still in flight when the worktrees are reset', async () => {
    const { api, callsTo } = createApi()
    const { result } = renderWorkspaceData(api)

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('a'))
    })
    expect(result.current.tree.isLoading).toBe(true)
    expect(result.current.changes.isLoading).toBe(true)

    // A different runbook was opened
    await act(async () => {
      result.current.workTrees.resetWorkTrees()
    })
    expect(result.current.tree.isLoading).toBe(false)
    expect(result.current.changes.isLoading).toBe(false)

    await settle(callsTo('workspace:tree'), { tree: [file('main.tf')], totalFiles: 1 })
    await settle(callsTo('workspace:changes'), { changes: [modified('main.tf')], totalChanges: 1 })
    expect(result.current.tree.tree).toBeNull()
    expect(result.current.tree.totalFiles).toBe(0)
    expect(result.current.changes.changes).toEqual([])
    expect(result.current.changes.totalChanges).toBe(0)
  })

  it('throws a clear error when read outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useGitFileChanges())).toThrow('useGitFileChanges must be used within a WorkspaceGitDataProvider')
    expect(() => renderHook(() => useGitFileTree())).toThrow('useGitFileTree must be used within a WorkspaceGitDataProvider')
  })
})
