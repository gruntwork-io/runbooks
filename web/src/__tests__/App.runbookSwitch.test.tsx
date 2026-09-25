import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ApiProvider } from '@/contexts/ApiContext'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { InstructionModeProvider } from '@/contexts/InstructionModeContext'
import { TelemetryContext, defaultContextValue } from '@/contexts/TelemetryContext.types'
import { ErrorReportingProvider } from '@/contexts/ErrorReportingContext'
import { GeneratedFilesProvider } from '@/contexts/GeneratedFilesContext'
import { IpcGitWorkTreeProvider } from '@/contexts/IpcGitWorkTreeContext'
import { LogsProvider } from '@/contexts/LogsContext'
import { useLogs } from '@/contexts/useLogs'
import App from '../App'

// The artifacts panel polls the workspace over IPC and the welcome screen
// checks the CLI install; neither is under test here.
vi.mock('@/components/layout/ArtifactsContainer', () => ({
  ArtifactsContainer: () => null,
}))
vi.mock('@/components/layout/WelcomeScreen', () => ({
  WelcomeScreen: () => <div>Welcome</div>,
}))

interface RunbookFixture {
  path: string
  content: string
}

const RUNBOOKS: Record<string, RunbookFixture> = {
  '/work/a': { path: '/work/a/runbook.mdx', content: '# Runbook A\n' },
  '/work/b': { path: '/work/b/runbook.mdx', content: '# Runbook B\n' },
  '/work/c': { path: '/work/c/runbook.mdx', content: '# Runbook C\n' },
}

const NO_RUNBOOK_MESSAGE = (dir: string) =>
  `This folder doesn't contain a runbook.mdx file:\n\n${dir}\n\nChoose a folder that contains a runbook.mdx file, or select a runbook file directly.`

/**
 * Mock preload api. `runbook:get` serves RUNBOOKS (and rejects like the real
 * handler for anything else); `generated-files:check` answers for whichever
 * runbook was loaded last, like the real session-scoped handler, with the
 * file count from `generatedFiles` (keyed by runbook file path).
 */
function makeApi(generatedFiles: Record<string, number> = {}) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let current: RunbookFixture | null = null

  const invoke = vi.fn(async (channel: string, params?: { path?: string; remoteSource?: string }) => {
    switch (channel) {
      case 'native:get-cli-config':
        return {}
      case 'runbook:get': {
        const fixture = params?.path ? RUNBOOKS[params.path] : undefined
        if (!fixture) throw new Error(NO_RUNBOOK_MESSAGE(params?.path ?? ''))
        current = fixture
        return {
          path: fixture.path,
          content: fixture.content,
          contentHash: fixture.path,
          language: 'mdx',
          size: fixture.content.length,
          isWatchMode: false,
          warnings: [],
          remoteSource: params?.remoteSource,
        }
      }
      case 'generated-files:check': {
        const fileCount = current ? generatedFiles[current.path] ?? 0 : 0
        return {
          hasFiles: fileCount > 0,
          fileCount,
          absoluteOutputPath: `${current?.path ?? ''}/generated`,
          relativeOutputPath: 'generated',
        }
      }
      default:
        return undefined
    }
  })

  const on = vi.fn((channel: string, cb: (payload: unknown) => void) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(cb)
    return () => listeners.get(channel)?.delete(cb)
  })

  const emit = async (channel: string, payload?: unknown) => {
    await act(async () => {
      listeners.get(channel)?.forEach((cb) => cb(payload))
    })
  }

  const api = { invoke, on, once: vi.fn() } as unknown as Parameters<typeof ApiProvider>[0]['api']
  return { api, invoke, emit }
}

/** Stands in for a block of the open runbook writing to the shared logs store. */
function LogSeeder() {
  const { registerLogs } = useLogs()
  return (
    <button onClick={() => registerLogs('create_account', [{ line: 'account_id=123', timestamp: '2026-01-01T00:00:00Z' }])}>
      Seed logs
    </button>
  )
}

function renderApp(generatedFiles?: Record<string, number>) {
  const mock = makeApi(generatedFiles)
  render(
    <ApiProvider api={mock.api}>
      <ThemeProvider>
        <InstructionModeProvider>
          <TelemetryContext.Provider value={defaultContextValue}>
            <ErrorReportingProvider>
              <GeneratedFilesProvider>
                <IpcGitWorkTreeProvider>
                  <LogsProvider>
                    <LogSeeder />
                    <App />
                  </LogsProvider>
                </IpcGitWorkTreeProvider>
              </GeneratedFilesProvider>
            </ErrorReportingProvider>
          </TelemetryContext.Provider>
        </InstructionModeProvider>
      </ThemeProvider>
    </ApiProvider>,
  )
  return mock
}

function callsTo(invoke: ReturnType<typeof makeApi>['invoke'], channel: string) {
  return invoke.mock.calls.filter(([c]) => c === channel)
}

function runbookGetCallsFor(invoke: ReturnType<typeof makeApi>['invoke'], path: string) {
  return callsTo(invoke, 'runbook:get').filter(([, params]) => params?.path === path).length
}

async function openRunbook(emit: ReturnType<typeof makeApi>['emit'], dir: string, heading: string) {
  await emit('file:open-runbook', { path: dir })
  // hidden: a modal (e.g. the generated-files alert) aria-hides the page behind it.
  expect(await screen.findByRole('heading', { name: heading, hidden: true })).toBeInTheDocument()
}

/** Confirm the "trust this runbook" banner and wait for it to fade out. */
async function trustRunbook() {
  fireEvent.click(await screen.findByRole('button', { name: /I trust this Runbook/ }))
  await waitFor(
    () => expect(screen.queryByText('Make sure you trust this Runbook!')).not.toBeInTheDocument(),
    { timeout: 3000 },
  )
}

/** Open the header menu (as Cmd+, does) and report whether log download is enabled. */
async function isLogDownloadEnabled(emit: ReturnType<typeof makeApi>['emit']) {
  await emit('menu:preferences')
  const item = await screen.findByRole('menuitem', { name: /Download logs \(Raw\)/ })
  const enabled = !item.hasAttribute('data-disabled')
  fireEvent.keyDown(item, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  return enabled
}

describe('App runbook switching', () => {
  beforeEach(() => localStorage.clear())

  it('resets per-runbook state when a different runbook is opened without closing the first', async () => {
    const { invoke, emit } = renderApp()
    await openRunbook(emit, '/work/a', 'Runbook A')
    await trustRunbook()
    fireEvent.click(screen.getByRole('button', { name: 'Seed logs' }))
    expect(await isLogDownloadEnabled(emit)).toBe(true)
    const checksBefore = callsTo(invoke, 'generated-files:check').length

    await openRunbook(emit, '/work/b', 'Runbook B')

    // B starts from a fresh RunbookContext, so its trust banner shows again.
    expect(screen.getByText('Make sure you trust this Runbook!')).toBeInTheDocument()
    // A's logs no longer count toward the download.
    expect(await isLogDownloadEnabled(emit)).toBe(false)
    // The generated-files check runs again for B's session.
    await waitFor(() =>
      expect(callsTo(invoke, 'generated-files:check').length).toBeGreaterThan(checksBefore),
    )
    expect(callsTo(invoke, 'generated-files:check').at(-1)?.[1]).toEqual({
      runbookPath: '/work/b/runbook.mdx',
    })
  })

  it('keeps per-runbook state when the same runbook is opened again', async () => {
    const { invoke, emit } = renderApp()
    await openRunbook(emit, '/work/a', 'Runbook A')
    await trustRunbook()
    fireEvent.click(screen.getByRole('button', { name: 'Seed logs' }))
    const checksBefore = callsTo(invoke, 'generated-files:check').length

    await emit('file:open-runbook', { path: '/work/a' })

    // The repeat open re-reads the runbook...
    await waitFor(() => expect(runbookGetCallsFor(invoke, '/work/a')).toBe(2))
    expect(screen.getByRole('heading', { name: 'Runbook A' })).toBeInTheDocument()
    // ...but it is the same runbook, so its state survives.
    expect(screen.queryByText('Make sure you trust this Runbook!')).not.toBeInTheDocument()
    expect(await isLogDownloadEnabled(emit)).toBe(true)
    expect(callsTo(invoke, 'generated-files:check').length).toBe(checksBefore)
  })

  it('checks generated files for each runbook, even after the alert was dismissed in the previous one', async () => {
    const { emit } = renderApp({ '/work/a/runbook.mdx': 3, '/work/b/runbook.mdx': 1 })

    await openRunbook(emit, '/work/a', 'Runbook A')
    expect(await screen.findByText('Existing Generated Files Detected')).toBeInTheDocument()
    expect(screen.getByText(/There are 3 files/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep Files' }))
    await waitFor(() =>
      expect(screen.queryByText('Existing Generated Files Detected')).not.toBeInTheDocument(),
    )

    await openRunbook(emit, '/work/b', 'Runbook B')
    expect(await screen.findByText(/There is 1 file/)).toBeInTheDocument()

    // Switching while the alert is open closes it when the new runbook has none.
    await openRunbook(emit, '/work/c', 'Runbook C')
    await waitFor(() =>
      expect(screen.queryByText('Existing Generated Files Detected')).not.toBeInTheDocument(),
    )
  })
})

describe('App failed runbook opens', () => {
  beforeEach(() => localStorage.clear())

  it('reports a failed open over the runbook that is still showing', async () => {
    const { emit } = renderApp()
    await openRunbook(emit, '/work/a', 'Runbook A')

    await emit('file:open-runbook', { path: '/work/empty' })

    expect(await screen.findByText(/This folder doesn't contain a runbook\.mdx file/)).toBeInTheDocument()
    expect(screen.getByText("Couldn't open runbook")).toBeInTheDocument()
    expect(screen.getByText('/work/a/runbook.mdx', { selector: 'span' })).toBeInTheDocument()
    // A stays mounted.
    expect(screen.getByRole('heading', { name: 'Runbook A' })).toBeInTheDocument()
  })

  it('retries the failed path from the banner', async () => {
    const { invoke, emit } = renderApp()
    await openRunbook(emit, '/work/a', 'Runbook A')
    await emit('file:open-runbook', { path: '/work/empty' })
    await screen.findByText(/This folder doesn't contain a runbook\.mdx file/)
    expect(runbookGetCallsFor(invoke, '/work/empty')).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(runbookGetCallsFor(invoke, '/work/empty')).toBe(2))
    expect(await screen.findByText(/This folder doesn't contain a runbook\.mdx file/)).toBeInTheDocument()
  })

  it('tries again when the same failed path is opened a second time', async () => {
    const { invoke, emit } = renderApp()
    await openRunbook(emit, '/work/a', 'Runbook A')
    await emit('file:open-runbook', { path: '/work/empty' })
    await screen.findByText(/This folder doesn't contain a runbook\.mdx file/)

    await emit('file:open-runbook', { path: '/work/empty' })

    await waitFor(() => expect(runbookGetCallsFor(invoke, '/work/empty')).toBe(2))
  })

  it('hides the banner on dismiss and keeps the current runbook', async () => {
    const { emit } = renderApp()
    await openRunbook(emit, '/work/a', 'Runbook A')
    await emit('file:open-runbook', { path: '/work/empty' })
    await screen.findByText(/This folder doesn't contain a runbook\.mdx file/)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByText(/This folder doesn't contain a runbook\.mdx file/)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Runbook A' })).toBeInTheDocument()
  })

  it('shows the full-screen error when the first open fails', async () => {
    const { invoke, emit } = renderApp()

    await emit('file:open-runbook', { path: '/work/empty' })

    expect(await screen.findByText(/This folder doesn't contain a runbook\.mdx file/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Choose Another Folder' }))
    expect(callsTo(invoke, 'native:open-runbook-dialog')).toHaveLength(1)
  })
})
