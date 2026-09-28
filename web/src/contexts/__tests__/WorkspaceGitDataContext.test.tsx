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

  it("clears the previous repo's tree until the next one loads when 'Clone again' hands over the active role", async () => {
    const { api, callsTo } = createApi()
    const { result } = renderWorkspaceData(api)

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('a'))
      result.current.workTrees.registerWorkTree(worktree('b'))
    })
    await settle(callsTo('workspace:tree', '/repos/a'), { tree: [lazyFolder('node_modules')], totalFiles: 3 })
    await act(async () => {
      void result.current.tree.fetchSubtree('node_modules')
    })
    const [subtreeOfA] = callsTo('workspace:tree', '/repos/a/node_modules')

    // 'Clone again' on a: b takes the active role and the tree is invalidated
    // in the same batch, so the path and treeVersion change together.
    await act(async () => {
      result.current.workTrees.unregisterWorkTree('a')
    })
    expect(result.current.workTrees.activeWorkTree?.id).toBe('b')
    expect(result.current.tree.tree).toBeNull()
    expect(result.current.tree.totalFiles).toBe(0)
    expect(result.current.tree.isLoading).toBe(true)

    // Neither a's late folder nor an expand issued in the gap grafts anything
    await settle([subtreeOfA], { tree: [file('left-pad')], totalFiles: 1 })
    await act(async () => {
      void result.current.tree.fetchSubtree('node_modules')
    })
    await settle(callsTo('workspace:tree', '/repos/b/node_modules'), { tree: [file('is-odd')], totalFiles: 1 })
    expect(result.current.tree.tree).toBeNull()
    expect(result.current.tree.isLoading).toBe(true)

    await settle(callsTo('workspace:tree', '/repos/b'), { tree: [lazyFolder('node_modules')], totalFiles: 2 })
    expect(result.current.tree.tree).toEqual([lazyFolder('node_modules')])
    expect(result.current.tree.totalFiles).toBe(2)
    expect(result.current.tree.isLoading).toBe(false)
  })

  it("never renders the previous clone's tree under a worktree re-registered at a new path", async () => {
    const { api, callsTo } = createApi()
    let workTrees!: GitWorkTreeContextType
    const renders: Array<{ path?: string; tree?: string[] }> = []
    function Consumer() {
      workTrees = useGitWorkTree()
      const { tree } = useGitFileTree()
      renders.push({ path: workTrees.activeWorkTree?.localPath, tree: tree?.map(n => n.id) })
      return null
    }
    render(
      <Providers api={api}>
        <Consumer />
      </Providers>,
    )

    await act(async () => {
      workTrees.registerWorkTree(worktree('a'))
    })
    await settle(callsTo('workspace:tree', '/repos/a'), { tree: [file('old-clone.tf')], totalFiles: 1 })

    // The block cloned again, into a new directory
    renders.length = 0
    await act(async () => {
      workTrees.registerWorkTree({ ...worktree('a'), localPath: '/repos/a-2' })
    })
    expect(renders.some(r => r.path === '/repos/a-2')).toBe(true)
    expect(renders.filter(r => r.path === '/repos/a-2' && r.tree !== undefined)).toEqual([])

    await settle(callsTo('workspace:tree', '/repos/a-2'), { tree: [file('new-clone.tf')], totalFiles: 1 })
    expect(renders.at(-1)).toEqual({ path: '/repos/a-2', tree: ['new-clone.tf'] })
  })

  it('keeps the current tree on screen, without a spinner, while a same-path invalidation refetches it', async () => {
    const { api, callsTo } = createApi()
    let workTrees!: GitWorkTreeContextType
    const renders: Array<{ tree?: string[]; isLoading: boolean }> = []
    function Consumer() {
      workTrees = useGitWorkTree()
      const { tree, isLoading } = useGitFileTree()
      renders.push({ tree: tree?.map(n => n.id), isLoading })
      return null
    }
    render(
      <Providers api={api}>
        <Consumer />
      </Providers>,
    )

    await act(async () => {
      workTrees.registerWorkTree(worktree('a'))
    })
    await settle(callsTo('workspace:tree', '/repos/a'), { tree: [file('main.tf')], totalFiles: 1 })
    expect(renders.at(-1)).toEqual({ tree: ['main.tf'], isLoading: false })

    // A script wrote to the repo: treeVersion bumps, the path stays the same
    renders.length = 0
    await act(async () => {
      workTrees.invalidateGitFileTree()
    })
    expect(callsTo('workspace:tree', '/repos/a')).toHaveLength(2)
    expect(renders.length).toBeGreaterThan(0)
    expect(renders.filter(r => r.isLoading || r.tree?.join() !== 'main.tf')).toEqual([])

    await settle(callsTo('workspace:tree', '/repos/a').slice(-1), { tree: [file('main.tf'), file('written-by-script.tf')], totalFiles: 2 })
    expect(renders.at(-1)).toEqual({ tree: ['main.tf', 'written-by-script.tf'], isLoading: false })
  })

  it('keeps one changes poll in flight across invalidations, then refetches once and drops the older response', async () => {
    const { api, callsTo } = createApi()
    const { result } = renderWorkspaceData(api)

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('a'))
    })
    const [beforeWrite] = callsTo('workspace:changes')

    // A template form auto-rendering over and over while git status still runs
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        result.current.workTrees.invalidateGitFileTree()
      })
    }
    expect(callsTo('workspace:changes')).toHaveLength(1)

    // The older response is dropped, and exactly one fetch follows it
    await settle([beforeWrite], { changes: [modified('before-the-write.tf')], totalChanges: 1 })
    expect(result.current.changes.changes).toEqual([])
    expect(result.current.changes.isLoading).toBe(true)
    const pending = callsTo('workspace:changes')
    expect(pending).toHaveLength(2)

    await settle([pending[1]], { changes: [modified('written-by-script.tf')], totalChanges: 1 })
    expect(result.current.changes.changes.map(c => c.path)).toEqual(['written-by-script.tf'])
    expect(result.current.changes.totalChanges).toBe(1)
    expect(result.current.changes.isLoading).toBe(false)
    expect(callsTo('workspace:changes')).toHaveLength(2)
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

    await settle([beforeWrite], { changes: [], totalChanges: 0 })
    expect(result.current.changes.isLoading).toBe(true)

    const [, current] = callsTo('workspace:changes')
    await settle([current], { changes: [modified('written-by-script.tf')], totalChanges: 1 })
    expect(result.current.changes.isLoading).toBe(false)
  })

  it("polls the new worktree as soon as the old worktree's poll lands after a switch, and drops that response", async () => {
    const { api, callsTo } = createApi()
    const { result } = renderWorkspaceData(api)

    await act(async () => {
      result.current.workTrees.registerWorkTree(worktree('a'))
      result.current.workTrees.registerWorkTree(worktree('b'))
    })
    await act(async () => {
      result.current.workTrees.setActiveWorkTree('b')
    })
    // One poll at a time: b's waits for a's
    expect(callsTo('workspace:changes', '/repos/b')).toHaveLength(0)

    await settle(callsTo('workspace:changes', '/repos/a'), { changes: [modified('a.tf'), modified('a2.tf')], totalChanges: 2 })
    expect(result.current.changes.changes).toEqual([])
    expect(result.current.changes.isLoading).toBe(true)
    expect(callsTo('workspace:changes', '/repos/b')).toHaveLength(1)

    await settle(callsTo('workspace:changes', '/repos/b'), { changes: [modified('b.tf')], totalChanges: 1 })
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
    // The poll a started when b registered lands first; b's follows it
    const pollsOfA = callsTo('workspace:changes', '/repos/a').filter(c => c.params.singleFile === undefined)
    await settle(pollsOfA.slice(1), { changes: [modified('main.tf', { diffTruncated: true })], totalChanges: 1 })
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
    // A script wrote to the repo while its first poll was running
    await act(async () => {
      result.current.workTrees.invalidateGitFileTree()
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
    // Nothing is left to poll, so the invalidation's fetch never runs
    expect(callsTo('workspace:changes')).toHaveLength(1)
  })

  it('throws a clear error when read outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useGitFileChanges())).toThrow('useGitFileChanges must be used within a WorkspaceGitDataProvider')
    expect(() => renderHook(() => useGitFileTree())).toThrow('useGitFileTree must be used within a WorkspaceGitDataProvider')
  })
})
