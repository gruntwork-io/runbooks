import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RunbookContextProvider } from '@/contexts/RunbookContext'
import { useBlockCompletion } from '../useBlockCompletion'

// MDXContainer passes remoteSource ?? runbookPath as the storage scope, and
// the short runbookName (the folder's basename) alongside it.
function wrapperFor(storageScope: string, runbookName = 'setup') {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <RunbookContextProvider runbookName={runbookName} storageScope={storageScope}>
        {children}
      </RunbookContextProvider>
    )
  }
}

describe('useBlockCompletion', () => {
  beforeEach(() => localStorage.clear())

  it('persists the done mark under the runbook storage scope', () => {
    const { result, unmount } = renderHook(() => useBlockCompletion('configure'), {
      wrapper: wrapperFor('catalog/aws/setup'),
    })
    act(() => result.current.toggle())
    expect(result.current.completed).toBe(true)
    expect(localStorage.getItem('instruction-done:catalog/aws/setup:configure')).toBe('true')
    unmount()

    const { result: reopened } = renderHook(() => useBlockCompletion('configure'), {
      wrapper: wrapperFor('catalog/aws/setup'),
    })
    expect(reopened.current.completed).toBe(true)
  })

  it('does not share done marks between runbooks whose folders have the same name', () => {
    const { result, unmount } = renderHook(() => useBlockCompletion('configure'), {
      wrapper: wrapperFor('catalog/aws/setup'),
    })
    act(() => result.current.toggle())
    unmount()

    const { result: other } = renderHook(() => useBlockCompletion('configure'), {
      wrapper: wrapperFor('catalog/gcp/setup'),
    })
    expect(other.current.completed).toBe(false)
  })
})
