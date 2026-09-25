import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ApiProvider, type RunbooksAPI } from '@/contexts/ApiContext'
import { ExecutableRegistryContext } from '@/contexts/ExecutableRegistryContext.types'
import { GeneratedFilesProvider } from '@/contexts/GeneratedFilesContext'
import { IpcGitWorkTreeProvider } from '@/contexts/IpcGitWorkTreeContext'
import { LogsProvider } from '@/contexts/LogsContext'
import { useRunbookContext } from '@/contexts/useRunbook'
import { TestWrapper } from '@/test/test-utils'
import { makeConfig } from '@/test/make-config'
import { BoilerplateVariableType } from '@/types/boilerplateVariable'
import { useScriptExecution } from '../useScriptExecution'

// `boilerplate:render-inline` calls stay pending until the test settles them,
// so the test decides the order in which renders land.
interface PendingRender {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

const renders: PendingRender[] = []
const invoke = vi.fn((channel: string) => {
  if (channel === 'boilerplate:render-inline') {
    return new Promise((resolve, reject) => {
      renders.push({ resolve, reject })
    })
  }
  return Promise.resolve({ ok: true })
})
const api = { invoke, on: vi.fn(() => () => {}), once: vi.fn() } as unknown as RunbooksAPI

const registry = {
  registry: null,
  warnings: [],
  loading: false,
  error: null,
  useExecutableRegistry: false,
  getExecutableByComponentId: () => null,
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <ApiProvider api={api}>
      <TestWrapper>
        <ExecutableRegistryContext.Provider value={registry}>
          <GeneratedFilesProvider>
            <IpcGitWorkTreeProvider>
              <LogsProvider>{children}</LogsProvider>
            </IpcGitWorkTreeProvider>
          </GeneratedFilesProvider>
        </ExecutableRegistryContext.Provider>
      </TestWrapper>
    </ApiProvider>
  )
}

const config = makeConfig([{ name: 'name', type: BoilerplateVariableType.String }])
const rendered = (content: string) => ({ renderedFiles: { 'script.sh': { content } } })

function renderCommand() {
  return renderHook(
    () => ({
      exec: useScriptExecution({
        componentId: 'greet',
        command: 'echo {{ .inputs.name }}',
        inputsId: 'form',
        componentType: 'command',
      }),
      runbook: useRunbookContext(),
    }),
    { wrapper: Providers },
  )
}

/** Type a value into the form and let the 300ms render debounce fire. */
async function typeName(result: ReturnType<typeof renderCommand>['result'], name: string) {
  await act(async () => {
    result.current.runbook.registerInputs('form', { name }, config)
  })
  await act(async () => {
    vi.advanceTimersByTime(300)
  })
}

const originalApi = window.api
beforeEach(() => {
  renders.length = 0
  invoke.mockClear()
  window.api = api
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  window.api = originalApi
})

describe('useScriptExecution render ordering', () => {
  it('shows the latest render when an earlier one lands after it', async () => {
    const { result } = renderCommand()

    await typeName(result, 'first')
    await typeName(result, 'second')
    expect(renders).toHaveLength(2)

    await act(async () => {
      renders[1].resolve(rendered('echo second'))
    })
    await act(async () => {
      renders[0].resolve(rendered('echo first'))
    })
    expect(result.current.exec.sourceCode).toBe('echo second')
    expect(result.current.exec.isRendering).toBe(false)
  })

  it('ignores a failure from a render that was already superseded', async () => {
    const { result } = renderCommand()

    await typeName(result, 'first')
    await typeName(result, 'second')

    await act(async () => {
      renders[1].resolve(rendered('echo second'))
    })
    await act(async () => {
      renders[0].reject(new Error('template: missing value for name'))
    })
    expect(result.current.exec.renderError).toBeNull()
    expect(result.current.exec.sourceCode).toBe('echo second')
  })
})
