import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useState } from 'react'
import { ApiProvider } from '@/contexts/ApiContext'
import { OpenUrlModal } from '../OpenUrlModal'

type OpenRemoteResult = { path: string; remoteSource: string }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Mock api whose runbook:open-remote calls resolve only when the test says so. */
function makeApi() {
  const pending: ReturnType<typeof deferred<OpenRemoteResult>>[] = []
  const invoke = vi.fn((channel: string) => {
    if (channel !== 'runbook:open-remote') return Promise.reject(new Error(`unexpected ${channel}`))
    const d = deferred<OpenRemoteResult>()
    pending.push(d)
    return d.promise
  })
  const api = { invoke, on: vi.fn(() => () => {}) } as unknown as Parameters<typeof ApiProvider>[0]['api']
  return { api, invoke, pending }
}

function Harness({ onOpened }: { onOpened: (path: string, remoteSource: string) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button onClick={() => setOpen(true)}>Reopen</button>
      <OpenUrlModal open={open} onOpenChange={setOpen} onOpened={onOpened} />
    </>
  )
}

function renderModal() {
  const { api, invoke, pending } = makeApi()
  const onOpened = vi.fn()
  render(
    <ApiProvider api={api}>
      <Harness onOpened={onOpened} />
    </ApiProvider>,
  )
  return { invoke, pending, onOpened }
}

function submit(url: string) {
  fireEvent.change(screen.getByPlaceholderText(/github\.com\/owner/), { target: { value: url } })
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
}

const RESULT_A = { path: '/tmp/runbooks-remote-a/repo/runbook.mdx', remoteSource: 'https://github.com/org/a' }
const RESULT_B = { path: '/tmp/runbooks-remote-b/repo/runbook.mdx', remoteSource: 'https://github.com/org/b' }

describe('OpenUrlModal', () => {
  it('opens the cloned runbook and closes once the clone finishes', async () => {
    const { invoke, pending, onOpened } = renderModal()
    submit('https://github.com/org/a')
    expect(invoke).toHaveBeenCalledWith('runbook:open-remote', { url: 'https://github.com/org/a' })
    expect(await screen.findByText('Cloning...')).toBeInTheDocument()

    await act(async () => pending[0].resolve(RESULT_A))

    expect(onOpened).toHaveBeenCalledWith(RESULT_A.path, RESULT_A.remoteSource)
    await waitFor(() => expect(screen.queryByText('Open from URL')).not.toBeInTheDocument())
  })

  it('shows a clone failure when the request was not cancelled', async () => {
    const { pending, onOpened } = renderModal()
    submit('https://github.com/org/a')

    await act(async () => pending[0].reject(new Error('repository not found')))

    expect(await screen.findByText('repository not found')).toBeInTheDocument()
    expect(onOpened).not.toHaveBeenCalled()
  })

  it('does not open the runbook when the clone finishes after Cancel', async () => {
    const { pending, onOpened } = renderModal()
    submit('https://github.com/org/a')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Open from URL')).not.toBeInTheDocument())

    await act(async () => pending[0].resolve(RESULT_A))

    expect(onOpened).not.toHaveBeenCalled()
    expect(screen.queryByText('Open from URL')).not.toBeInTheDocument()
  })

  it('does not leave a stale error behind when the clone fails after Cancel', async () => {
    const { pending } = renderModal()
    submit('https://github.com/org/a')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await act(async () => pending[0].reject(new Error('repository not found')))

    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(await screen.findByText('Open from URL')).toBeInTheDocument()
    expect(screen.queryByText('repository not found')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText(/github\.com\/owner/)).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument()
  })

  it('ignores a cancelled clone that finishes while a newer one is running', async () => {
    const { pending, onOpened } = renderModal()
    submit('https://github.com/org/a')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await screen.findByText('Open from URL')
    submit('https://github.com/org/b')

    // The cancelled first request finishing must not close the modal or open A.
    await act(async () => pending[0].resolve(RESULT_A))
    expect(onOpened).not.toHaveBeenCalled()
    expect(screen.getByText('Cloning...')).toBeInTheDocument()

    await act(async () => pending[1].resolve(RESULT_B))
    expect(onOpened).toHaveBeenCalledTimes(1)
    expect(onOpened).toHaveBeenCalledWith(RESULT_B.path, RESULT_B.remoteSource)
  })
})
