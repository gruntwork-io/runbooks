import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ViewOutputs } from '../ViewOutputs'

// Outputs a script marked `sensitive:` must never be shown on screen (screen
// shares, recordings, screenshots), but the row's copy button still copies
// the real value. The clipboard is the boundary: userEvent installs a stub
// clipboard, and the spy records what was written to it.
function setup(outputs: Record<string, string>, sensitiveKeys?: string[]) {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText')
  render(<ViewOutputs outputs={outputs} sensitiveKeys={sensitiveKeys} autoOpen />)
  return { user, writeText }
}

const OUTPUTS = { AWS_SECRET_ACCESS_KEY: 'topsecret', region: 'us-west-2' }

describe('ViewOutputs sensitive outputs', () => {
  it('masks a sensitive value and shows the others', () => {
    setup(OUTPUTS, ['AWS_SECRET_ACCESS_KEY'])

    expect(document.body.innerHTML).not.toContain('topsecret')
    expect(screen.getByText('AWS_SECRET_ACCESS_KEY')).toBeInTheDocument()
    expect(screen.getByText('••••••••')).toBeInTheDocument()
    expect(screen.getByText('Sensitive value hidden')).toBeInTheDocument()
    expect(screen.getByText('us-west-2')).toBeInTheDocument()
  })

  it("copies the real value from the sensitive row's copy button", async () => {
    const { user, writeText } = setup(OUTPUTS, ['AWS_SECRET_ACCESS_KEY'])

    await user.click(screen.getByRole('button', { name: 'Copy value of AWS_SECRET_ACCESS_KEY' }))

    expect(writeText).toHaveBeenCalledWith('topsecret')
  })

  it('redacts sensitive values in Copy JSON and says so', async () => {
    const { user, writeText } = setup(OUTPUTS, ['AWS_SECRET_ACCESS_KEY'])

    const copyJson = screen.getByRole('button', { name: /Copy JSON/ })
    await user.hover(copyJson)
    expect((await screen.findAllByText('Copy outputs as JSON (sensitive values redacted)')).length).toBeGreaterThan(0)

    await user.click(copyJson)

    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0][0]
    expect(copied).not.toContain('topsecret')
    expect(JSON.parse(copied)).toEqual({ AWS_SECRET_ACCESS_KEY: '[REDACTED]', region: 'us-west-2' })
  })

  it('never shows a long sensitive value, even on hover', async () => {
    const secret = 'S'.repeat(150)
    const plain = 'p'.repeat(150)
    const { user } = setup({ TOKEN: secret, LONG_PLAIN: plain }, ['TOKEN'])

    // A long plain value shows in full in a tooltip on hover...
    await user.hover(screen.getByText(`${'p'.repeat(100)}...`))
    await waitFor(() => expect(document.body.innerHTML).toContain(plain))

    // ...but a sensitive one has nothing to hover but the mask
    await user.hover(screen.getByText('••••••••'))
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(document.body.innerHTML).not.toContain('S'.repeat(20))
  })

  it('shows and copies values as before when nothing is sensitive', async () => {
    const { user, writeText } = setup(OUTPUTS)

    expect(screen.getByText('topsecret')).toBeInTheDocument()
    expect(screen.queryByText('••••••••')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Copy value of AWS_SECRET_ACCESS_KEY' }))
    expect(writeText).toHaveBeenLastCalledWith('topsecret')

    await user.click(screen.getByRole('button', { name: /Copy JSON/ }))
    expect(writeText).toHaveBeenLastCalledWith(JSON.stringify(OUTPUTS, null, 2))
  })
})
