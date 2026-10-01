import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, act, cleanup } from '@testing-library/react'
import { ApiProvider, type RunbooksAPI } from '@/contexts/ApiContext'
import { RunbookContextProvider } from '@/contexts/RunbookContext'
import { useRunbookContext, type TemplateValue } from '@/contexts/useRunbook'
import { SENSITIVE_DISPLAY_RENDER_NOTE, useScriptExecution } from '../useScriptExecution'
import { isSensitiveOutput, revealOutputs, sensitiveOutput, type OutputValues } from '@/lib/outputValues'

// The hook runs inside the real RunbookContextProvider, so inputs and block
// outputs reach it through registerInputs/registerOutputs exactly as they do in
// the app. Only the contexts that would need their own providers, and the IPC
// bridge, are stubbed. The bridge is both handed to ApiProvider (renders) and
// set as window.api (useApiExec runs and cancels through it directly).
vi.mock('@/hooks/useExecutableRegistry', () => {
  const registry = {
    getExecutableByComponentId: (componentId: string) => ({ id: `exec-${componentId}`, componentId }),
    registryVersion: 0,
  }
  return { useExecutableRegistry: () => registry }
})
vi.mock('@/hooks/useGeneratedFiles', () => {
  const ctx = { updateGeneratedFileTree: () => {} }
  return { useGeneratedFiles: () => ctx }
})
vi.mock('@/contexts/useGitWorkTree', () => {
  const ctx = { invalidateGitFileTree: () => {} }
  return { useGitWorkTree: () => ctx }
})
vi.mock('@/contexts/useLogs', () => {
  const ctx = { registerLogs: () => {} }
  return { useLogs: () => ctx }
})

/**
 * Stands in for the boilerplate engine: substitutes each `{{ .inputs.x }}` /
 * `{{ .outputs.block.key }}` from the payload the hook sends.
 */
function fakeRenderInline(args: unknown) {
  const { templateFiles, inputs } = args as { templateFiles: Record<string, string>; inputs: TemplateValue[] }
  const ctx = Object.fromEntries(inputs.map((v) => [v.name, v.value]))
  const content = templateFiles['script.sh'].replace(/\{\{\s*\.([\w.]+)\s*\}\}/g, (_, path: string) =>
    String(path.split('.').reduce<unknown>((obj, key) => (obj as Record<string, unknown>)[key], ctx)),
  )
  return { renderedFiles: { 'script.sh': { content } } }
}

let invoke: ReturnType<typeof vi.fn>
let api: RunbooksAPI
const originalApi = window.api

beforeEach(() => {
  invoke = vi.fn(async (channel: string, args?: unknown) => {
    if (channel === 'boilerplate:render-inline') return fakeRenderInline(args)
    // Leave the run in flight: these tests only look at what was sent.
    if (channel === 'exec:run') return new Promise(() => {})
    return {}
  })
  api = { invoke, on: vi.fn(() => () => {}) } as unknown as RunbooksAPI
  window.api = api
})

afterEach(() => {
  // Unmount first: the hook cancels its run through window.api on unmount.
  cleanup()
  window.api = originalApi
})

type Props = Omit<Parameters<typeof useScriptExecution>[0], 'componentId' | 'componentType'>

function renderScriptExecution(props: Props) {
  return renderHook(
    (p: Props) => ({
      exec: useScriptExecution({ componentId: 'target', componentType: 'command', ...p }),
      runbook: useRunbookContext(),
    }),
    {
      initialProps: props,
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(ApiProvider, { api }, createElement(RunbookContextProvider, null, children)),
    },
  )
}

function renderWithOutputs(props: Props, outputs: Record<string, OutputValues>) {
  const hook = renderScriptExecution(props)
  act(() => {
    for (const [blockId, values] of Object.entries(outputs)) {
      hook.result.current.runbook.registerOutputs(blockId, values)
    }
  })
  return hook
}

const renderCalls = () => invoke.mock.calls.filter(([channel]) => channel === 'boilerplate:render-inline')

describe('useScriptExecution — auth gates', () => {
  it('keeps a googleAuthId block gated when the referenced block withdrew its authentication', () => {
    // buildGoogleAuthEnvVars always emits the blank CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE,
    // so only the markerOnly check reads __AUTHENTICATED here. Without it the gate
    // could never re-close.
    const { result } = renderWithOutputs(
      { command: 'gcloud projects list', googleAuthId: 'gcp' },
      { gcp: { __AUTHENTICATED: 'false' } },
    )
    expect(result.current.exec.hasGoogleAuthDependency).toBe(false)
    expect(result.current.exec.unmetGoogleAuthDependency).toEqual({ blockId: 'gcp' })
  })

  it('gates a googleAuthId block whose referenced block has not run', () => {
    const { result } = renderScriptExecution({ command: 'gcloud projects list', googleAuthId: 'gcp' })
    expect(result.current.exec.hasGoogleAuthDependency).toBe(false)
  })

  it('opens a googleAuthId block for an access-token credential with no credential file', () => {
    const { result } = renderWithOutputs(
      { command: 'gcloud projects list', googleAuthId: 'gcp' },
      {
        gcp: {
          GOOGLE_APPLICATION_CREDENTIALS: '',
          CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '',
          CLOUDSDK_CORE_PROJECT: 'proj',
          __AUTHENTICATED: 'true',
        },
      },
    )
    expect(result.current.exec.hasGoogleAuthDependency).toBe(true)
  })

  it('opens an awsAuthId block once the referenced block has an access key and secret', () => {
    const { result } = renderWithOutputs(
      { command: 'aws sts get-caller-identity', awsAuthId: 'aws' },
      { aws: { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret' } },
    )
    expect(result.current.exec.hasAwsAuthDependency).toBe(true)
  })

  it('gates an awsAuthId block whose referenced block ran without credentials', () => {
    const { result } = renderWithOutputs(
      { command: 'aws sts get-caller-identity', awsAuthId: 'aws' },
      { aws: {} },
    )
    expect(result.current.exec.hasAwsAuthDependency).toBe(false)
    expect(result.current.exec.unmetAwsAuthDependency).toEqual({ blockId: 'aws' })
  })

  it('opens a gitAuthId block when the referenced block emitted GITLAB_TOKEN', () => {
    const { result } = renderWithOutputs(
      { command: 'glab repo list', gitAuthId: 'git' },
      { git: { GITLAB_TOKEN: 'glpat-x', GITLAB_USER: 'tanuki' } },
    )
    expect(result.current.exec.hasGitHubAuthDependency).toBe(true)
  })

  it('gates a gitAuthId block whose referenced block has no token', () => {
    const { result } = renderWithOutputs({ command: 'glab repo list', gitAuthId: 'git' }, { git: {} })
    expect(result.current.exec.hasGitHubAuthDependency).toBe(false)
    expect(result.current.exec.unmetGitHubAuthDependency).toEqual({ blockId: 'git' })
  })
})

describe('useScriptExecution — execute', () => {
  it('sends blank AWS_SESSION_TOKEN and CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE rather than dropping them', () => {
    // Both blanks overwrite values another auth block may have left in the
    // session env. Dropping them would run this script with that block's
    // session token or gcloud credential.
    const { result } = renderWithOutputs(
      { command: 'deploy', awsAuthId: 'aws', googleAuthId: 'gcp' },
      {
        aws: { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret', AWS_REGION: 'us-east-1' },
        gcp: { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '', CLOUDSDK_CORE_PROJECT: 'proj', __AUTHENTICATED: 'true' },
      },
    )

    act(() => result.current.exec.execute())

    expect(invoke).toHaveBeenCalledWith(
      'exec:run',
      expect.objectContaining({
        executableId: 'exec-target',
        envVarsOverride: expect.objectContaining({
          AWS_ACCESS_KEY_ID: 'AKIA',
          AWS_SECRET_ACCESS_KEY: 'secret',
          AWS_SESSION_TOKEN: '',
          CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '',
          CLOUDSDK_CORE_PROJECT: 'proj',
        }),
      }),
    )
  })

  it('passes the real value of a credential the referenced block marked sensitive', () => {
    const { result } = renderWithOutputs(
      { command: 'aws sts get-caller-identity', awsAuthId: 'mint' },
      { mint: { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: sensitiveOutput('topsecret') } },
    )

    act(() => result.current.exec.execute())

    expect(invoke).toHaveBeenCalledWith(
      'exec:run',
      expect.objectContaining({
        envVarsOverride: expect.objectContaining({ AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'topsecret' }),
      }),
    )
  })
})

describe('useScriptExecution — outputs', () => {
  it('keeps a sensitive output wrapped, for display and for downstream blocks', () => {
    // Record what the run subscribes to, so the test can send its events
    const handlers = new Map<string, (data: unknown) => void>()
    vi.mocked(api.on).mockImplementation(((channel: string, handler: (data: unknown) => void) => {
      handlers.set(channel, handler)
      return () => handlers.delete(channel)
    }) as unknown as RunbooksAPI['on'])
    const { result } = renderScriptExecution({ command: 'mint-token' })

    act(() => result.current.exec.execute())
    act(() =>
      handlers.get('exec:outputs')?.({
        outputs: { TOKEN: { value: 'x', sensitive: true }, user: { value: 'u', sensitive: false } },
      }),
    )

    // ViewOutputs gets the wrapped value, so it masks it
    const shown = result.current.exec.outputs ?? {}
    expect(isSensitiveOutput(shown.TOKEN)).toBe(true)
    expect(shown.user).toBe('u')
    // Downstream blocks get the same, and read the real value through revealOutput
    const registered = result.current.runbook.blockOutputs.target?.values ?? {}
    expect(isSensitiveOutput(registered.TOKEN)).toBe(true)
    expect(revealOutputs(registered)).toEqual({ TOKEN: 'x', user: 'u' })
  })
})

describe('useScriptExecution — template render', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('renders once, 300ms after the last input change', async () => {
    const { result } = renderScriptExecution({ command: 'echo {{ .inputs.name }}', inputsId: 'cfg' })

    act(() => result.current.runbook.registerInputs('cfg', { name: 'w' }, { variables: [] }))
    await advance(200)
    act(() => result.current.runbook.registerInputs('cfg', { name: 'wo' }, { variables: [] }))
    await advance(299)
    expect(renderCalls()).toHaveLength(0)

    await advance(1)
    expect(renderCalls()).toHaveLength(1)
    expect(result.current.exec.sourceCode).toBe('echo wo')
  })

  it('does not render while an output dependency is missing', async () => {
    const { result } = renderScriptExecution({ command: 'echo {{ .outputs.a.x }}' })

    await advance(1000)
    expect(renderCalls()).toHaveLength(0)
    expect(result.current.exec.hasAllOutputDependencies).toBe(false)
    expect(result.current.exec.sourceCode).toBe('echo {{ .outputs.a.x }}')
  })

  it('renders again when an output disappears and comes back with the same value', async () => {
    // A re-run of block A that fails without outputs registers {} for A, which
    // replaces its earlier values. When A succeeds again with the same value,
    // the render key matches the one from before, so the hook must not treat
    // it as already rendered: the display was cleared in between.
    const { result } = renderScriptExecution({ command: 'echo {{ .outputs.a.x }}' })

    act(() => result.current.runbook.registerOutputs('a', { x: 'foo' }))
    await advance(300)
    expect(result.current.exec.sourceCode).toBe('echo foo')

    act(() => result.current.runbook.registerOutputs('a', {}))
    await advance(300)
    expect(result.current.exec.hasAllOutputDependencies).toBe(false)
    expect(result.current.exec.sourceCode).toBe('echo {{ .outputs.a.x }}')

    act(() => result.current.runbook.registerOutputs('a', { x: 'foo' }))
    await advance(300)
    expect(result.current.exec.hasAllOutputDependencies).toBe(true)
    expect(result.current.exec.sourceCode).toBe('echo foo')
  })

  it('shows a sensitive output as <redacted> in the rendered script, but runs with its real value', async () => {
    const { result } = renderScriptExecution({ command: 'curl -H "Authorization: {{ .outputs.a.token }}" {{ .outputs.a.url }}' })

    act(() => result.current.runbook.registerOutputs('a', { token: sensitiveOutput('s3cr3t'), url: 'https://x' }))
    await advance(300)

    // The script view is only shown, so its render never gets the secret
    expect(result.current.exec.sourceCode).toBe('curl -H "Authorization: <redacted>" https://x')
    expect(JSON.stringify(renderCalls())).not.toContain('s3cr3t')

    // execute() renders the script again in the main process, with the real value
    act(() => result.current.exec.execute())
    expect(invoke).toHaveBeenCalledWith(
      'exec:run',
      expect.objectContaining({
        templateVarValues: { inputs: {}, outputs: { a: { token: 's3cr3t', url: 'https://x' } } },
      }),
    )
  })

  // The script view renders `<redacted>`, which a template that parses the
  // value can't handle, as boilerplate's fromJson fails on it. The error says
  // why, since the run renders the real value and succeeds.
  describe('when the script view render fails', () => {
    const FROM_JSON_ERROR = 'template: script.sh:1:26: executing "script.sh" at <.outputs.a.creds>: nil data; no entry for key "user"'
    beforeEach(() => {
      invoke.mockImplementation(async (channel: string) => {
        if (channel === 'boilerplate:render-inline') throw new Error(FROM_JSON_ERROR)
        return {}
      })
    })

    it('explains it when the script uses a sensitive output', async () => {
      const { result } = renderScriptExecution({ command: 'echo user={{ (fromJson .outputs.a.creds).user }}' })

      act(() => result.current.runbook.registerOutputs('a', { creds: sensitiveOutput('{"user":"bob"}') }))
      await advance(300)

      expect(result.current.exec.renderError).toEqual({ message: FROM_JSON_ERROR, details: SENSITIVE_DISPLAY_RENDER_NOTE })
    })

    it('keeps the usual details when it does not', async () => {
      const { result } = renderScriptExecution({ command: 'echo user={{ (fromJson .outputs.a.creds).user }}' })

      act(() => result.current.runbook.registerOutputs('a', { creds: '{"user":"bob"}' }))
      await advance(300)

      expect(result.current.exec.renderError).toEqual({ message: FROM_JSON_ERROR, details: 'Failed to render script with variables' })
    })
  })

  // An empty value reveals nothing, and the script view's `{{ if }}` then takes the same branch as the run
  it('renders an empty sensitive output as empty in the script view', async () => {
    const { result } = renderScriptExecution({ command: 'echo [{{ .outputs.a.token }}]' })

    act(() => result.current.runbook.registerOutputs('a', { token: sensitiveOutput('') }))
    await advance(300)

    expect(result.current.exec.sourceCode).toBe('echo []')
  })

  it('renders the new command when the command changes but the values do not', async () => {
    const { result, rerender } = renderScriptExecution({ command: 'echo {{ .outputs.a.x }}' })

    act(() => result.current.runbook.registerOutputs('a', { x: 'foo' }))
    await advance(300)
    expect(result.current.exec.sourceCode).toBe('echo foo')

    rerender({ command: 'ls {{ .outputs.a.x }}' })
    await advance(300)
    expect(result.current.exec.sourceCode).toBe('ls foo')
  })
})
