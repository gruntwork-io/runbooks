import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { act, type ReactNode } from 'react'
import { ApiProvider, type RunbooksAPI } from './ApiContext'
import { IpcGitWorkTreeProvider } from './IpcGitWorkTreeContext'
import { useGitWorkTree } from './useGitWorkTree'
import type { GitWorkTree } from './gitWorkTreeTypes'

const invoke = vi.fn(async (_channel: string, _params?: unknown) => ({ ok: true }))
const api = { invoke, on: vi.fn(() => () => {}), once: vi.fn() } as unknown as RunbooksAPI

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ApiProvider api={api}>
      <IpcGitWorkTreeProvider>{children}</IpcGitWorkTreeProvider>
    </ApiProvider>
  )
}

function workTree(id: string, localPath: string): GitWorkTree {
  return {
    id,
    repoUrl: `https://github.com/acme/${id}.git`,
    localPath,
    gitInfo: { repoUrl: `https://github.com/acme/${id}.git`, repoName: id, repoOwner: 'acme', ref: 'main' },
  }
}

/** The worktree paths the backend was told to make active, in order. */
const activeSyncs = () =>
  invoke.mock.calls
    .filter(([channel]) => channel === 'workspace:set-active')
    .map(([, params]) => (params as { worktreePath: string }).worktreePath)

beforeEach(() => {
  invoke.mockClear()
})

describe('IpcGitWorkTreeProvider', () => {
  it('re-syncs the backend when the active worktree is re-registered at a new path', () => {
    const { result } = renderHook(() => useGitWorkTree(), { wrapper: Wrapper })

    act(() => result.current.registerWorkTree(workTree('clone', '/work/a')))
    // The block cloned again, into a different directory.
    act(() => result.current.registerWorkTree(workTree('clone', '/work/b')))

    expect(result.current.activeWorkTree?.localPath).toBe('/work/b')
    // REPO_FILES and target="worktree" writes follow the new clone.
    expect(activeSyncs()).toEqual(['/work/a', '/work/b'])
  })

  it('leaves the backend alone when another worktree is re-registered', () => {
    const { result } = renderHook(() => useGitWorkTree(), { wrapper: Wrapper })

    act(() => result.current.registerWorkTree(workTree('first', '/work/first')))
    act(() => result.current.registerWorkTree(workTree('second', '/work/second')))
    act(() => result.current.registerWorkTree(workTree('second', '/work/second-again')))

    expect(result.current.activeWorkTreeId).toBe('first')
    expect(activeSyncs()).toEqual(['/work/first'])
  })

  describe('unregisterWorkTree', () => {
    it('removes the only worktree and clears the active selection', () => {
      const { result } = renderHook(() => useGitWorkTree(), { wrapper: Wrapper })
      act(() => result.current.registerWorkTree(workTree('clone', '/work/a')))
      const version = result.current.treeVersion

      act(() => result.current.unregisterWorkTree('clone'))

      expect(result.current.workTrees).toEqual([])
      expect(result.current.activeWorkTree).toBeNull()
      expect(result.current.treeVersion).toBeGreaterThan(version)
    })

    it('hands the active role to a remaining worktree, on the backend too', () => {
      const { result } = renderHook(() => useGitWorkTree(), { wrapper: Wrapper })
      act(() => result.current.registerWorkTree(workTree('first', '/work/first')))
      act(() => result.current.registerWorkTree(workTree('second', '/work/second')))

      act(() => result.current.unregisterWorkTree('first'))

      expect(result.current.workTrees.map(wt => wt.id)).toEqual(['second'])
      expect(result.current.activeWorkTreeId).toBe('second')
      expect(activeSyncs().at(-1)).toBe('/work/second')
    })

    it('gives the active role back when the displaced worktree registers again', () => {
      const { result } = renderHook(() => useGitWorkTree(), { wrapper: Wrapper })
      act(() => result.current.registerWorkTree(workTree('first', '/work/first')))
      act(() => result.current.registerWorkTree(workTree('second', '/work/second')))
      // The first block clicks "Clone again": the second stands in meanwhile.
      act(() => result.current.unregisterWorkTree('first'))
      invoke.mockClear()

      // Its new clone must win back the role, or <GitPullRequest> would
      // target the second block's repository.
      act(() => result.current.registerWorkTree(workTree('first', '/work/first-again')))

      expect(result.current.activeWorkTreeId).toBe('first')
      expect(activeSyncs()).toEqual(['/work/first-again'])

      // Handed back once only: the second re-registering later doesn't take it.
      act(() => result.current.registerWorkTree(workTree('second', '/work/second-again')))
      expect(result.current.activeWorkTreeId).toBe('first')
    })

    it('gives the role back to the original holder when its stand-in also starts over', () => {
      const { result } = renderHook(() => useGitWorkTree(), { wrapper: Wrapper })
      act(() => result.current.registerWorkTree(workTree('first', '/work/first')))
      act(() => result.current.registerWorkTree(workTree('second', '/work/second')))
      act(() => result.current.unregisterWorkTree('first'))
      act(() => result.current.unregisterWorkTree('second'))
      expect(result.current.activeWorkTreeId).toBeNull()

      act(() => result.current.registerWorkTree(workTree('second', '/work/second-again')))
      act(() => result.current.registerWorkTree(workTree('first', '/work/first-again')))

      expect(result.current.activeWorkTreeId).toBe('first')
      expect(activeSyncs().at(-1)).toBe('/work/first-again')
    })

    it('keeps an explicit choice over handing the role back', () => {
      const { result } = renderHook(() => useGitWorkTree(), { wrapper: Wrapper })
      act(() => result.current.registerWorkTree(workTree('first', '/work/first')))
      act(() => result.current.registerWorkTree(workTree('second', '/work/second')))
      act(() => result.current.unregisterWorkTree('first'))
      act(() => result.current.setActiveWorkTree('second'))

      act(() => result.current.registerWorkTree(workTree('first', '/work/first-again')))

      expect(result.current.activeWorkTreeId).toBe('second')
    })

    it("keeps another block's registration from the same tick, and hands it the role", () => {
      const { result } = renderHook(() => useGitWorkTree(), { wrapper: Wrapper })
      act(() => result.current.registerWorkTree(workTree('first', '/work/first')))

      // The second block's clone lands and the first block clicks "Clone
      // again" before React renders in between.
      act(() => {
        const { registerWorkTree, unregisterWorkTree } = result.current
        registerWorkTree(workTree('second', '/work/second'))
        unregisterWorkTree('first')
      })

      expect(result.current.workTrees.map(wt => wt.id)).toEqual(['second'])
      expect(result.current.activeWorkTreeId).toBe('second')
      expect(activeSyncs().at(-1)).toBe('/work/second')
    })

    it('keeps the active worktree when a different one is removed', () => {
      const { result } = renderHook(() => useGitWorkTree(), { wrapper: Wrapper })
      act(() => result.current.registerWorkTree(workTree('first', '/work/first')))
      act(() => result.current.registerWorkTree(workTree('second', '/work/second')))
      invoke.mockClear()

      act(() => result.current.unregisterWorkTree('second'))

      expect(result.current.workTrees.map(wt => wt.id)).toEqual(['first'])
      expect(result.current.activeWorkTreeId).toBe('first')
      expect(activeSyncs()).toEqual([])
    })

    it('ignores an id that was never registered', () => {
      const { result } = renderHook(() => useGitWorkTree(), { wrapper: Wrapper })
      act(() => result.current.registerWorkTree(workTree('clone', '/work/a')))
      const version = result.current.treeVersion

      act(() => result.current.unregisterWorkTree('other'))

      expect(result.current.workTrees.map(wt => wt.id)).toEqual(['clone'])
      expect(result.current.treeVersion).toBe(version)
    })
  })
})
