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
 *  - every `{{ .inputs.* }}` / `{{ .outputs.* }}` value reference in a
 *    displayed command resolves to a value or a `<name>` placeholder, whether or
 *    not the engine is available;
 *  - an input referenced only inside template logic is never given a
 *    placeholder, so that logic is never evaluated against one.
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

  it('shows an unset input as a <name> placeholder and resolves a nested input, engine offline', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('engine offline'))
    const ctx: TemplateContext = {
      inputs: { prefix: undefined, _module: { source: 'git::x' } },
      outputs: {},
    }

    renderWithApi(
      <Instruction
        title="Run this:"
        command={[
          'aws s3 ls s3://{{ .inputs.bucket }}/{{ .inputs.prefix }}',
          'echo {{ .inputs._module.source }}',
        ]}
        templateContext={ctx}
      />,
      invoke,
    )

    await screen.findByText(/simplified resolver/)
    expect(screen.getByText('aws s3 ls s3://<bucket>/<prefix>')).toBeInTheDocument()
    expect(screen.getByText('echo git::x')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('{{')
  })

  it('sends the engine a <name> placeholder for an unset input', async () => {
    const invoke = vi.fn().mockResolvedValue({
      renderedFiles: { 'cmd-0': { content: 'aws s3 ls <bucket>' } },
    })

    renderWithApi(
      <Instruction
        title="Run this:"
        command="aws s3 ls {{ .inputs.bucket }}"
        templateContext={{ inputs: { bucket: undefined }, outputs: {} }}
      />,
      invoke,
    )

    await waitFor(() => expect(invoke).toHaveBeenCalled())
    const [, params] = invoke.mock.calls[0]
    expect(params.inputs).toContainEqual(
      expect.objectContaining({ name: 'inputs', value: { bucket: '<bucket>' } }),
    )
    expect(await screen.findByText('aws s3 ls <bucket>')).toBeInTheDocument()
    expect(screen.queryByText(/simplified resolver/)).toBeNull()
  })

  it('falls back, and says so, when the engine returns a [template error] marker or a raw template', async () => {
    const invoke = vi.fn().mockResolvedValue({
      renderedFiles: {
        'cmd-0': {
          content:
            '[template error: template: cmd-0:1:12: executing "cmd-0" at <.inputs.bucket>: map has no entry for key "bucket"]',
        },
        'cmd-1': { content: 'echo {{ .inputs.region }}' },
      },
    })

    renderWithApi(
      <Instruction
        title="Run this:"
        command={['aws s3 ls {{ .inputs.bucket }}', 'echo {{ .inputs.region }}']}
        templateContext={{ inputs: { region: 'us-east-1' }, outputs: {} }}
      />,
      invoke,
    )

    await screen.findByText(/simplified resolver/)
    expect(screen.getByText('aws s3 ls <bucket>')).toBeInTheDocument()
    expect(screen.getByText('echo us-east-1')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('[template error')
    expect(document.body.textContent).not.toContain('{{')
  })

  it('gives no placeholder to an unset input used only in a conditional', async () => {
    // A stand-in for the engine: `if` on a missing key is an error (the WASM
    // engine renders with OnMissingKey=ExitWithError); any set value is truthy.
    const invoke = vi.fn().mockImplementation(async (_channel, params) => {
      const inputs = params.inputs.find((v: { name: string }) => v.name === 'inputs')?.value ?? {}
      const content = !('auto_approve' in inputs)
        ? '[template error: template: cmd-0:1:24: executing "cmd-0" at <.inputs.auto_approve>: map has no entry for key "auto_approve"]'
        : inputs.auto_approve
          ? 'terraform destroy -auto-approve'
          : 'terraform destroy '
      return { renderedFiles: { 'cmd-0': { content } } }
    })
    const command = 'terraform destroy {{ if .inputs.auto_approve }}-auto-approve{{ end }}'

    renderWithApi(
      <Instruction
        title="Run this:"
        command={command}
        templateContext={{ inputs: { auto_approve: undefined }, outputs: {} }}
      />,
      invoke,
    )

    // The unchecked, unset bool gets no placeholder: the engine can't decide
    // the branch, so the logic is shown as written, flagged by the note.
    await screen.findByText(/simplified resolver/)
    expect(screen.getByText(command)).toBeInTheDocument()
    expect(screen.queryByText('terraform destroy -auto-approve')).toBeNull()
    const [, params] = invoke.mock.calls[0]
    expect(params.inputs).toContainEqual(
      expect.objectContaining({ name: 'inputs', value: { auto_approve: undefined } }),
    )
  })
})
