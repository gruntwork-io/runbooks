import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BlockIdLabel } from '../BlockIdLabel'

const ID = 'plan-management'

const copyIcon = (badge: HTMLElement) => badge.querySelector('.lucide-copy')
const checkIcon = (badge: HTMLElement) => badge.querySelector('.lucide-check')

// userEvent.setup() replaces navigator.clipboard with an in-memory stub, so
// these tests read back what a click really wrote.
describe('BlockIdLabel', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

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
    expect(await within(badge).findByText(ID)).toBeInTheDocument()
    expect(copyIcon(badge)).not.toBeNull()
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(screen.queryByText(/unique identifier/i)).toBeNull()

    await user.unhover(badge)
    expect(screen.queryByText(ID)).toBeNull()
    expect(badge).toHaveTextContent(/^ID$/)
  })

  // In instruction mode the pill grows leftward over the "Mark as done"
  // button beside the badge, so it must not open for a pointer that is only
  // passing over the badge on its way somewhere else.
  it('expands only after the pointer rests on the badge, not as it passes over', () => {
    // fireEvent rather than userEvent: userEvent stalls under fake timers.
    vi.useFakeTimers()
    render(<BlockIdLabel id={ID} size="large" />)
    const badge = screen.getByRole('button', { name: 'Copy block ID' })

    fireEvent.mouseEnter(badge)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(screen.queryByText(ID)).toBeNull()
    fireEvent.mouseLeave(badge)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.queryByText(ID)).toBeNull()

    fireEvent.mouseEnter(badge)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(within(badge).getByText(ID)).toBeInTheDocument()
  })

  it('copies the ID when the badge is clicked and confirms it with a check mark', async () => {
    const user = userEvent.setup()
    render(<BlockIdLabel id={ID} size="large" />)
    const badge = screen.getByRole('button', { name: 'Copy block ID' })

    await user.click(badge)

    // A click is deliberate, so it expands the badge at once rather than
    // waiting out the hover delay, and the check mark shows straight away.
    expect(within(badge).getByText(ID)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Copied block ID' })).toBeInTheDocument()
    expect(checkIcon(badge)).not.toBeNull()
    expect(copyIcon(badge)).toBeNull()
    expect(await navigator.clipboard.readText()).toBe(ID)
  })

  it('copies when the revealed ID itself is clicked', async () => {
    const user = userEvent.setup()
    render(<BlockIdLabel id={ID} size="large" />)
    const badge = screen.getByRole('button', { name: 'Copy block ID' })

    await user.hover(badge)
    const revealedId = await within(badge).findByText(ID)
    // A plain click event: user.click would first move the pointer onto the
    // child with no relatedTarget, which React reads as leaving the badge
    // (a browser names the child, so the badge stays hovered there).
    // act() lets the async copy's state update settle inside the test.
    await act(async () => {
      fireEvent.click(revealedId)
    })

    expect(await navigator.clipboard.readText()).toBe(ID)
    expect(badge).toHaveAccessibleName('Copied block ID')
    expect(checkIcon(badge)).not.toBeNull()
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
    expect(await within(badge).findByText(ID)).toBeInTheDocument()

    await user.click(badge)
    expect(await navigator.clipboard.readText()).toBe(ID)
    expect(badge).toHaveAccessibleName('Copied block ID')
    expect(checkIcon(badge)).not.toBeNull()
  })

  // The accessible name stays a fixed "Copy block ID" (so name queries such
  // as /run/i never match an ID like "run-setup"); the ID itself is exposed as
  // the description, so a screen reader announces which ID it copies.
  it('exposes the ID to assistive technology as its description', () => {
    render(<BlockIdLabel id={ID} size="large" />)

    const badge = screen.getByRole('button', { name: 'Copy block ID' })
    expect(badge).toHaveAccessibleDescription(ID)
  })
})
