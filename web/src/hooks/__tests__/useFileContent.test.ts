import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { ApiProvider, type RunbooksAPI } from '@/contexts/ApiContext'
import { useFileContent } from '../useFileContent'

// `workspace:file` reads stay pending until the test settles them, so each
// test decides the order in which they land.
interface PendingRead {
  filePath: string
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

function setup() {
  const reads: PendingRead[] = []
  const invoke = vi.fn((_channel: string, params: { filePath: string }) =>
    new Promise((resolve, reject) => {
      reads.push({ filePath: params.filePath, resolve, reject })
    }),
  )
  const api = { invoke, on: vi.fn(() => () => {}) } as unknown as RunbooksAPI
  const wrapper = ({ children }: { children: ReactNode }) => createElement(ApiProvider, { api }, children)
  const { result } = renderHook(() => useFileContent(), { wrapper })
  const readsOf = (filePath: string) => reads.filter(r => r.filePath === filePath)
  const pendingRead = (filePath: string) => {
    const read = readsOf(filePath).at(-1)
    if (!read) throw new Error(`no read issued for ${filePath}`)
    return read
  }
  return { result, invoke, pendingRead, readsOf }
}

const content = (path: string, text: string) => ({ path, content: text, language: 'hcl', size: text.length })

describe('useFileContent', () => {
  it('keeps showing a cached file clicked after a slower read of another file', async () => {
    const { result, pendingRead } = setup()

    // Y is read once, so it's cached
    await act(async () => {
      void result.current.fetchFileContent('/repo/y.tf')
    })
    await act(async () => {
      pendingRead('/repo/y.tf').resolve(content('/repo/y.tf', 'y'))
    })

    // Click X (slow), then Y again (cache hit)
    await act(async () => {
      void result.current.fetchFileContent('/repo/x.tf')
    })
    expect(result.current.isLoading).toBe(true)
    await act(async () => {
      void result.current.fetchFileContent('/repo/y.tf')
    })
    expect(result.current.fileContent?.content).toBe('y')
    expect(result.current.isLoading).toBe(false)

    await act(async () => {
      pendingRead('/repo/x.tf').resolve(content('/repo/x.tf', 'x'))
    })
    expect(result.current.fileContent?.content).toBe('y')
    expect(result.current.isLoading).toBe(false)
  })

  it('lets a newer read of a file land when that file is clicked again from the cache', async () => {
    const { result, invoke, pendingRead } = setup()

    // A click, then a refetch after the file changed on disk: two reads of X in flight
    await act(async () => {
      void result.current.fetchFileContent('/repo/x.tf')
    })
    const olderRead = pendingRead('/repo/x.tf')
    await act(async () => {
      void result.current.refetchFileContent('/repo/x.tf')
    })
    const newerRead = pendingRead('/repo/x.tf')

    // The older read lands first and fills the cache
    await act(async () => {
      olderRead.resolve(content('/repo/x.tf', 'before the write'))
    })

    // Clicking X again hits the cache while the newer read is still running
    await act(async () => {
      void result.current.fetchFileContent('/repo/x.tf')
    })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(result.current.fileContent?.content).toBe('before the write')
    expect(result.current.isLoading).toBe(true)

    await act(async () => {
      newerRead.resolve(content('/repo/x.tf', 'after the write'))
    })
    expect(result.current.fileContent?.content).toBe('after the write')
    expect(result.current.isLoading).toBe(false)
  })

  it('lets a newer read of a file land when it is clicked from the cache after another file', async () => {
    const { result, pendingRead, readsOf } = setup()

    await act(async () => {
      void result.current.fetchFileContent('/repo/x.tf')
      void result.current.refetchFileContent('/repo/x.tf')
    })
    const [olderRead, newerRead] = readsOf('/repo/x.tf')
    await act(async () => {
      olderRead.resolve(content('/repo/x.tf', 'before the write'))
    })

    // Y, then X again from the cache, while X's newer read still runs
    await act(async () => {
      void result.current.fetchFileContent('/repo/y.tf')
    })
    await act(async () => {
      void result.current.fetchFileContent('/repo/x.tf')
    })
    await act(async () => {
      pendingRead('/repo/y.tf').resolve(content('/repo/y.tf', 'y'))
    })
    expect(result.current.fileContent?.content).toBe('before the write')
    expect(result.current.isLoading).toBe(true)

    await act(async () => {
      newerRead.resolve(content('/repo/x.tf', 'after the write'))
    })
    expect(result.current.fileContent?.content).toBe('after the write')
    expect(result.current.isLoading).toBe(false)
  })

  it("does not let an older read of a file overwrite the cache after that file's newer read landed", async () => {
    const { result, invoke, readsOf } = setup()

    // A click, then a refetch after the file changed on disk: two reads of X in flight
    await act(async () => {
      void result.current.fetchFileContent('/repo/x.tf')
      void result.current.refetchFileContent('/repo/x.tf')
    })
    const [olderRead, newerRead] = readsOf('/repo/x.tf')

    // The newer read lands first, then the older one
    await act(async () => {
      newerRead.resolve(content('/repo/x.tf', 'after the write'))
    })
    await act(async () => {
      olderRead.resolve(content('/repo/x.tf', 'before the write'))
    })
    expect(result.current.fileContent?.content).toBe('after the write')

    // Clicking X again is a cache hit, and it must be the fresher content
    await act(async () => {
      void result.current.fetchFileContent('/repo/x.tf')
    })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(result.current.fileContent?.content).toBe('after the write')
  })

  it('still caches a superseded read, since the content is right for its own path', async () => {
    const { result, invoke, pendingRead } = setup()

    await act(async () => {
      void result.current.fetchFileContent('/repo/x.tf')
      void result.current.fetchFileContent('/repo/y.tf')
    })
    await act(async () => {
      pendingRead('/repo/y.tf').resolve(content('/repo/y.tf', 'y'))
      pendingRead('/repo/x.tf').resolve(content('/repo/x.tf', 'x'))
    })
    expect(result.current.fileContent?.content).toBe('y')

    await act(async () => {
      void result.current.fetchFileContent('/repo/x.tf')
    })
    expect(result.current.fileContent?.content).toBe('x')
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('keeps the spinner while the file clicked last is still loading', async () => {
    const { result, pendingRead } = setup()

    await act(async () => {
      void result.current.fetchFileContent('/repo/x.tf')
      void result.current.fetchFileContent('/repo/y.tf')
    })
    await act(async () => {
      pendingRead('/repo/x.tf').resolve(content('/repo/x.tf', 'x'))
    })
    expect(result.current.isLoading).toBe(true)
    expect(result.current.fileContent).toBeNull()

    await act(async () => {
      pendingRead('/repo/y.tf').resolve(content('/repo/y.tf', 'y'))
    })
    expect(result.current.isLoading).toBe(false)
    expect(result.current.fileContent?.content).toBe('y')
  })

  it("does not show an error from a read the user has already moved on from", async () => {
    const { result, pendingRead } = setup()

    await act(async () => {
      void result.current.fetchFileContent('/repo/x.tf')
      void result.current.fetchFileContent('/repo/y.tf')
    })
    await act(async () => {
      pendingRead('/repo/y.tf').resolve(content('/repo/y.tf', 'y'))
    })
    expect(result.current.isLoading).toBe(false)

    await act(async () => {
      pendingRead('/repo/x.tf').reject(new Error('EACCES'))
    })
    expect(result.current.error).toBeNull()
    expect(result.current.fileContent?.content).toBe('y')
  })

  it('does not cache a read that was issued before clearCache', async () => {
    const { result, invoke, pendingRead } = setup()

    await act(async () => {
      void result.current.fetchFileContent('/repo/x.tf')
    })
    // A script rewrote the worktree while the old content was being read
    act(() => {
      result.current.clearCache()
    })
    await act(async () => {
      pendingRead('/repo/x.tf').resolve(content('/repo/x.tf', 'before the write'))
    })

    await act(async () => {
      void result.current.fetchFileContent('/repo/x.tf')
    })
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
