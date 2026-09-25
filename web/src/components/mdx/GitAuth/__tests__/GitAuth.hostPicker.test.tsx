import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import { ApiProvider, type RunbooksAPI } from '@/contexts/ApiContext'

// The GitLab host picker against the REAL useGitAuth hook: what the select
// shows and what "Other instance…" does are only visible with the hook, the
// picker and the PAT form wired together.
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({ isReady: true }),
}))

import { GitAuth } from '../GitAuth'

const HOSTS = {
  hosts: [
    { host: 'gitlab.com', sources: ['glab'], hasCredential: true },
    { host: 'git.corp.example', sources: ['recent'], hasCredential: false },
  ],
  defaultHost: 'gitlab.com',
}

let currentApi: RunbooksAPI

function installApi(impl: (channel: string, args?: unknown) => Promise<unknown>) {
  const invoke = vi.fn(impl)
  currentApi = { invoke, on: vi.fn(() => () => {}), once: vi.fn() } as unknown as RunbooksAPI
  return invoke
}

function renderWithApi(ui: ReactNode) {
  return render(
    <TestWrapper>
      <ApiProvider api={currentApi}>{ui}</ApiProvider>
    </TestWrapper>,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

const instanceField = () => screen.getByPlaceholderText('https://gitlab.com')

describe('GitAuth — GitLab host picker (real hook)', () => {
  it("'Other instance…' leaves the success card and focuses the instance-URL field", async () => {
    installApi(async (channel) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      if (channel === 'gitlab:env-credentials') {
        return { found: true, valid: true, user: { login: 'tanuki' }, host: 'gitlab.com', envVar: 'GITLAB_TOKEN' }
      }
      return { found: false }
    })

    renderWithApi(<GitAuth id="git" provider="gitlab" />)
    await screen.findByText(/Authenticated to GitLab \(gitlab\.com\)/)

    const select = screen.getByRole('combobox')
    fireEvent.change(select, { target: { value: '__other__' } })

    await waitFor(() => expect(instanceField()).toHaveFocus())
    expect(screen.queryByText(/Authenticated to GitLab/)).toBeNull()
    // The sentinel is not a host: the select snaps back.
    expect(select).toHaveValue('gitlab.com')
  })

  it('shows an entered instance in the picker, and picking a listed host replaces it', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      return { found: false }
    })

    renderWithApi(<GitAuth id="git" provider="gitlab" />)
    await screen.findByPlaceholderText(/GitLab access token/i)
    const select = screen.getByRole('combobox')

    fireEvent.change(select, { target: { value: '__other__' } })
    await waitFor(() => expect(instanceField()).toHaveFocus())
    fireEvent.change(instanceField(), { target: { value: 'https://gitlab.new.example' } })

    // Not the first listed host: that would hide what detection targets, and
    // picking it would fire no change.
    expect(select).toHaveValue('gitlab.new.example')

    const callsBefore = invoke.mock.calls.length
    fireEvent.change(select, { target: { value: 'gitlab.com' } })

    await waitFor(() => {
      expect(invoke.mock.calls.slice(callsBefore)).toContainEqual(['gitlab:cli-credentials', { host: 'gitlab.com' }])
    })
    await screen.findByPlaceholderText('https://gitlab.com')
    expect(instanceField()).toHaveValue('')
    expect(select).toHaveValue('gitlab.com')
    // The re-detection remounted the form; the earlier pick doesn't re-take focus.
    expect(instanceField()).not.toHaveFocus()
  })
})
