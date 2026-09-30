import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BlockIdLabel } from '../BlockIdLabel'

const ID = 'plan-management'

// userEvent.setup() replaces navigator.clipboard with an in-memory stub, so
// these tests read back what a click really wrote.
describe('BlockIdLabel', () => {
  it('shows only "ID" at rest, as a button that copies the block ID', () => {
    render(<BlockIdLabel id={ID} size="large" />)

    const badge = screen.getByRole('button', { name: 'Copy block ID' })
    expect(badge).toHaveAttribute('type', 'button')
    expect(badge).toHaveTextContent(/^ID$/)
    expect(screen.queryByText(ID)).toBeNull()
    // No explanation popover: the badge is self-explanatory, and the docs
    // cover what block IDs are for.
    expect(screen.queryByText(/unique identifier/i)).toBeNull()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('reveals the ID inline on hover, with no tooltip, and hides it again on leave', async () => {
    const user = userEvent.setup()
    render(<BlockIdLabel id={ID} size="large" />)
    const badge = screen.getByRole('button', { name: 'Copy block ID' })

    await user.hover(badge)
    expect(within(badge).getByText(ID)).toBeInTheDocument()
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(screen.queryByText(/unique identifier/i)).toBeNull()

    await user.unhover(badge)
    expect(screen.queryByText(ID)).toBeNull()
    expect(badge).toHaveTextContent(/^ID$/)
  })

  it('copies the ID when the badge is clicked and confirms it', async () => {
    const user = userEvent.setup()
    render(<BlockIdLabel id={ID} size="large" />)

    await user.click(screen.getByRole('button', { name: 'Copy block ID' }))

    expect(await navigator.clipboard.readText()).toBe(ID)
    expect(await screen.findByRole('button', { name: 'Copied block ID' })).toBeInTheDocument()
  })

  it('copies when the revealed ID itself is clicked', async () => {
    const user = userEvent.setup()
    render(<BlockIdLabel id={ID} size="large" />)
    const badge = screen.getByRole('button', { name: 'Copy block ID' })

    await user.hover(badge)
    // A plain click event: user.click would first move the pointer onto the
    // child with no relatedTarget, which React reads as leaving the badge
    // (a browser names the child, so the badge stays hovered there).
    fireEvent.click(within(badge).getByText(ID))

    expect(await navigator.clipboard.readText()).toBe(ID)
    expect(await screen.findByRole('button', { name: 'Copied block ID' })).toBeInTheDocument()
  })

  // A clicked button would otherwise keep focus, and with it the expanded
  // pill, covering the block header after the pointer has gone.
  it('does not stay expanded after a mouse click once the pointer leaves', async () => {
    const user = userEvent.setup()
    render(<BlockIdLabel id={ID} size="large" />)
    const badge = screen.getByRole('button', { name: 'Copy block ID' })

    await user.click(badge)
    await user.unhover(badge)

    expect(badge).not.toHaveFocus()
    expect(screen.queryByText(ID)).toBeNull()
  })

  it('is reachable by keyboard: focus reveals the ID, Enter copies, leaving hides it', async () => {
    const user = userEvent.setup()
    render(
      <>
        <BlockIdLabel id={ID} size="large" />
        <input aria-label="next field" />
      </>,
    )
    const badge = screen.getByRole('button', { name: 'Copy block ID' })

    await user.tab()
    expect(badge).toHaveFocus()
    expect(within(badge).getByText(ID)).toBeInTheDocument()

    await user.keyboard('{Enter}')
    expect(await navigator.clipboard.readText()).toBe(ID)
    expect(badge).toHaveAccessibleName('Copied block ID')

    await user.tab()
    expect(screen.getByRole('textbox', { name: 'next field' })).toHaveFocus()
    expect(screen.queryByText(ID)).toBeNull()
  })

  it('does not pass the click on to the block around it', async () => {
    const user = userEvent.setup()
    const onParentClick = vi.fn()
    render(
      <div onClick={onParentClick}>
        <BlockIdLabel id={ID} size="large" />
      </div>,
    )

    await user.click(screen.getByRole('button', { name: 'Copy block ID' }))

    expect(await navigator.clipboard.readText()).toBe(ID)
    expect(onParentClick).not.toHaveBeenCalled()
  })

  it('behaves the same in the small size', async () => {
    const user = userEvent.setup()
    render(<BlockIdLabel id={ID} size="small" />)
    const badge = screen.getByRole('button', { name: 'Copy block ID' })
    expect(badge).toHaveTextContent(/^ID$/)

    await user.hover(badge)
    expect(within(badge).getByText(ID)).toBeInTheDocument()

    await user.click(badge)
    expect(await navigator.clipboard.readText()).toBe(ID)
    expect(badge).toHaveAccessibleName('Copied block ID')
  })
})
