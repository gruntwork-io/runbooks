import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ViewOutputs } from '../ViewOutputs'
import { sensitiveOutput, type OutputValues } from '@/lib/outputValues'

// Outputs a script marked `sensitive:` must never be shown on screen (screen
// shares, recordings, screenshots), but the row's copy button still copies
// the real value. The clipboard is the boundary: userEvent installs a stub
// clipboard, and the spy records what was written to it.
//
// ViewOutputs takes nothing but the outputs, the way every block renders it
// (Command/Check, GitClone, GitPullRequest): a sensitive value masks itself.
function setup(outputs: OutputValues) {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText')
  render(<ViewOutputs outputs={outputs} autoOpen />)
  return { user, writeText }
}

const OUTPUTS: OutputValues = { AWS_SECRET_ACCESS_KEY: sensitiveOutput('topsecret'), region: 'us-west-2' }
const PLAIN_OUTPUTS: OutputValues = { AWS_SECRET_ACCESS_KEY: 'topsecret', region: 'us-west-2' }

describe('ViewOutputs sensitive outputs', () => {
  it('masks a sensitive value and shows the others', () => {
    setup(OUTPUTS)

    expect(document.body.innerHTML).not.toContain('topsecret')
    expect(screen.getByText('AWS_SECRET_ACCESS_KEY')).toBeInTheDocument()
    expect(screen.getByText('••••••••')).toBeInTheDocument()
    expect(screen.getByText('Sensitive value hidden')).toBeInTheDocument()
    expect(screen.getByText('us-west-2')).toBeInTheDocument()
  })

  it("copies the real value from the sensitive row's copy button", async () => {
    const { user, writeText } = setup(OUTPUTS)

    await user.click(screen.getByRole('button', { name: 'Copy value of AWS_SECRET_ACCESS_KEY' }))

    expect(writeText).toHaveBeenCalledWith('topsecret')
  })

  it('redacts sensitive values in Copy JSON and says so', async () => {
    const { user, writeText } = setup(OUTPUTS)

    const copyJson = screen.getByRole('button', { name: /Copy JSON/ })
    await user.hover(copyJson)
    expect((await screen.findAllByText('Copy outputs as JSON (sensitive values redacted)')).length).toBeGreaterThan(0)

    await user.click(copyJson)

    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0][0]
    expect(copied).not.toContain('topsecret')
    expect(JSON.parse(copied)).toEqual({ AWS_SECRET_ACCESS_KEY: '<redacted>', region: 'us-west-2' })
  })

  it('never shows a long sensitive value, even on hover', async () => {
    // Fake timers, so the check below runs well after any tooltip's open delay
    // (350ms) however slow the runner is
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const secret = 'S'.repeat(150)
      const plain = 'p'.repeat(150)
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<ViewOutputs outputs={{ TOKEN: sensitiveOutput(secret), LONG_PLAIN: plain }} autoOpen />)

      // A long plain value shows in full in a tooltip on hover...
      await user.hover(screen.getByText(`${'p'.repeat(100)}...`))
      await waitFor(() => expect(document.body.innerHTML).toContain(plain))

      // ...but a sensitive one has nothing to hover but the mask
      await user.hover(screen.getByText('••••••••'))
      await act(() => vi.advanceTimersByTimeAsync(1000))
      expect(document.body.innerHTML).not.toContain('S'.repeat(20))
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows and copies values as before when nothing is sensitive', async () => {
    const { user, writeText } = setup(PLAIN_OUTPUTS)

    expect(screen.getByText('topsecret')).toBeInTheDocument()
    expect(screen.queryByText('••••••••')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Copy value of AWS_SECRET_ACCESS_KEY' }))
    expect(writeText).toHaveBeenLastCalledWith('topsecret')

    await user.click(screen.getByRole('button', { name: /Copy JSON/ }))
    expect(writeText).toHaveBeenLastCalledWith(JSON.stringify(PLAIN_OUTPUTS, null, 2))
  })
})
