import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SearchInput } from './SearchInput'

describe('SearchInput', () => {
  it('shows no clear button while the field is empty', () => {
    render(<SearchInput value="" onChange={() => {}} placeholder="Search projects..." />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  // The clear button is icon-only, so without a label a screen reader announces
  // a nameless button.
  it('gives the clear button an accessible name and makes it a non-submitting button', () => {
    render(<SearchInput value="prod" onChange={() => {}} placeholder="Search projects..." />)
    const clear = screen.getByRole('button', { name: 'Clear search' })
    expect(clear).toHaveAttribute('type', 'button')
  })

  it('clears the value, even when the text field is disabled', () => {
    const onChange = vi.fn()
    render(<SearchInput value="prod" onChange={onChange} placeholder="Search projects..." disabled />)
    expect(screen.getByPlaceholderText('Search projects...')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(onChange).toHaveBeenCalledWith('')
  })
})
