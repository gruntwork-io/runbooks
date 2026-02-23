import React from 'react'
import type { Variable } from '../../../shared/types'
import { VariableInput } from './VariableInput'

interface VariableFormProps {
  variables: Variable[]
  values: Record<string, unknown>
  onChange: (name: string, value: unknown) => void
}

export function VariableForm({ variables, values, onChange }: VariableFormProps) {
  // Sort by order, then by name
  const sorted = [...variables].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    return a.name.localeCompare(b.name)
  })

  if (sorted.length === 0) {
    return (
      <div className="text-sm text-neutral-400 italic py-4">
        No variables defined in this template.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {sorted.map((variable) => (
        <VariableInput
          key={variable.name}
          variable={variable}
          value={values[variable.name]}
          onChange={(val) => onChange(variable.name, val)}
        />
      ))}
    </div>
  )
}
