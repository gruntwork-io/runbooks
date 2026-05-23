import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiProvider } from '@/contexts/ApiContext'
import { Instruction } from './Instruction'
import type { TemplateContext } from '@/lib/templateUtils'

/**
 * Cross-cutting instruction-mode guarantees that live in the shared resolution
 * path (spec §10):
 *  - the only IPC channel touched while resolving is the side-effect-free
 *    boilerplate:render-inline — never exec:run, render-to-disk, clone, push, PR;
 *  - no displayed command ever contains a raw `{{ … }}`.
 */

const FORBIDDEN_CHANNELS = [
  'exec:run',
  'boilerplate:render',
  'git:clone',
  'git:push',
  'git:pull-request',
  'git:delete-branch',
]

function makeApi(invoke: ReturnType<typeof vi.fn>) {
  return { invoke, on: vi.fn(() => () => {}) } as unknown as Parameters<
    typeof ApiProvider
  >[0]['api']
}

function renderWithApi(ui: React.ReactNode, invoke: ReturnType<typeof vi.fn>) {
  return render(
    <ApiProvider api={makeApi(invoke)}>
      <TooltipProvider>{ui}</TooltipProvider>
    </ApiProvider>,
  )
}

describe('instruction mode — nothing runs', () => {
  it('only ever calls boilerplate:render-inline while resolving a command', async () => {
    const invoke = vi.fn().mockResolvedValue({
      renderedFiles: { 'cmd-0': { content: 'aws s3 ls my-bucket' } },
    })
    const ctx: TemplateContext = { inputs: { bucket: 'my-bucket' }, outputs: {} }

    renderWithApi(
      <Instruction
        title="Run this:"
        command="aws s3 ls {{ .inputs.bucket }}"
        templateContext={ctx}
      />,
      invoke,
    )

    await waitFor(() => expect(invoke).toHaveBeenCalled())
    const channels = invoke.mock.calls.map((c) => c[0])
    for (const channel of channels) {
      expect(FORBIDDEN_CHANNELS).not.toContain(channel)
    }
    expect(channels.every((c) => c === 'boilerplate:render-inline')).toBe(true)
  })
})

describe('instruction mode — no unresolved template references', () => {
  it('never displays a command containing {{ — input, output, and empty cases', async () => {
    // Engine unavailable here (invoke rejects) → client-side fallback, which is
    // the backstop that guarantees no raw template survives.
    const invoke = vi.fn().mockRejectedValue(new Error('engine offline'))
    const ctx: TemplateContext = { inputs: { region: 'us-east-1' }, outputs: {} }

    renderWithApi(
      <Instruction
        title="Run this:"
        command={[
          'aws configure set region {{ .inputs.region }}',
          'echo {{ .outputs.create_account.account_id }}',
        ]}
        templateContext={ctx}
      />,
      invoke,
    )

    await waitFor(() =>
      expect(screen.getByText('aws configure set region us-east-1')).toBeInTheDocument(),
    )
    // The output reference resolves to a <placeholder>, never a raw {{ }}.
    expect(screen.getByText('echo <account_id>')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('{{')
  })
})
