import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FormControl } from '../FormControls'
import type { BoilerplateVariable } from '@/types/boilerplateVariable'

// Each select must display the value that is actually in form state, so the
// user never sees a choice that downstream blocks don't receive.
describe('FormControls selects match form state', () => {
  it('shows a placeholder for an enum with no value, and picking the first option fires onChange', () => {
    const variable: BoilerplateVariable = {
      name: 'Env', type: 'enum', description: '', options: ['dev', 'prod'],
    }
    const onChange = vi.fn()
    render(<FormControl id="f" variable={variable} value={undefined} onChange={onChange} />)

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(screen.getByRole('option', { name: 'Select…' })).toBeInTheDocument()

    fireEvent.change(select, { target: { value: 'dev' } })
    expect(onChange).toHaveBeenCalledWith('dev')
  })

  it('shows no placeholder once the enum has a value', () => {
    const variable: BoilerplateVariable = {
      name: 'Env', type: 'enum', description: '', options: ['dev', 'prod'],
    }
    render(<FormControl id="f" variable={variable} value="prod" onChange={vi.fn()} />)

    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('prod')
    expect(screen.queryByRole('option', { name: 'Select…' })).toBeNull()
  })

  it('shows an enum value that is not one of the options instead of the first option', () => {
    const variable: BoilerplateVariable = {
      name: 'Env', type: 'enum', description: '', options: ['dev', 'prod'],
    }
    render(<FormControl id="f" variable={variable} value="staging" onChange={vi.fn()} />)

    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('staging')
    expect(screen.getByRole('option', { name: 'staging' })).toBeInTheDocument()
  })

  it("saves an untouched bool field of a map entry as 'false'", () => {
    const variable: BoilerplateVariable = {
      name: 'Users', type: 'map', description: '', schema: { email: 'string', admin: 'bool' },
    }
    const onChange = vi.fn()
    render(<FormControl id="f" variable={variable} value={{}} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.change(screen.getByLabelText(/Entry name/), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText(/email/), { target: { value: 'a@example.com' } })
    // The admin select displays 'false' but is never touched.
    expect((screen.getByLabelText(/admin/) as HTMLSelectElement).value).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: /Save Entry/ }))

    expect(onChange).toHaveBeenCalledWith({ alice: { email: 'a@example.com', admin: 'false' } })
  })

  it('emits the displayed false for an untouched bool element of a tuple', () => {
    const variable: BoilerplateVariable = {
      name: 'Pair', type: 'list', description: '', schema: { '0': 'string', '1': 'bool' },
    }
    const onChange = vi.fn()
    render(<FormControl id="f" variable={variable} value={undefined} onChange={onChange} />)

    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('false')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } })

    expect(onChange).toHaveBeenCalledWith(['x', false])
  })

  it('fills a missing bool element of a short tuple array with the displayed false', () => {
    const variable: BoilerplateVariable = {
      name: 'Pair', type: 'list', description: '', schema: { '0': 'string', '1': 'bool' },
    }
    const onChange = vi.fn()
    render(<FormControl id="f" variable={variable} value={[]} onChange={onChange} />)

    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('false')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } })

    expect(onChange).toHaveBeenCalledWith(['x', false])
  })
})
