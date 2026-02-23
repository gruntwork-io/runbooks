import React, { useState, useMemo } from 'react'
import yaml from 'yaml'

interface InputVariable {
  name: string
  description?: string
  type?: string
  default?: unknown
  options?: string[]
}

interface InputsProps {
  id: string
  children?: React.ReactNode
  variant?: string
  [key: string]: unknown
}

/**
 * Inputs / BoilerplateInputs block
 * Parses variable definitions from inline YAML (in children code blocks)
 * and renders a form for the user to fill in values.
 */
export function Inputs({ id, children }: InputsProps) {
  const variables = useMemo(() => parseVariablesFromChildren(children), [children])
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const defaults: Record<string, unknown> = {}
    for (const v of variables) {
      if (v.default !== undefined) defaults[v.name] = v.default
    }
    return defaults
  })

  if (variables.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 mb-4">
        <div className="text-xs font-mono text-neutral-400">Inputs: {id}</div>
        <div className="text-sm text-neutral-500 mt-1">No variables defined</div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 mb-4">
      <div className="text-xs font-mono text-neutral-400 mb-3">Inputs: {id}</div>
      <div className="space-y-3">
        {variables.map((v) => (
          <VariableInput
            key={v.name}
            variable={v}
            value={values[v.name]}
            onChange={(val) => setValues((prev) => ({ ...prev, [v.name]: val }))}
          />
        ))}
      </div>
    </div>
  )
}

// Alias for BoilerplateInputs (same component)
export const BoilerplateInputs = Inputs

function VariableInput({
  variable,
  value,
  onChange,
}: {
  variable: InputVariable
  value: unknown
  onChange: (val: unknown) => void
}) {
  const type = variable.type || 'string'

  return (
    <div>
      <label className="block text-sm font-medium text-neutral-700 mb-1">
        {variable.name}
        {variable.description && (
          <span className="font-normal text-neutral-400 ml-2">{variable.description}</span>
        )}
      </label>

      {type === 'enum' && variable.options ? (
        <select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-1.5 text-sm border border-neutral-300 rounded-md bg-white"
        >
          {variable.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : type === 'bool' ? (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="rounded border-neutral-300"
        />
      ) : (
        <input
          type={type === 'int' || type === 'float' ? 'number' : 'text'}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-1.5 text-sm border border-neutral-300 rounded-md"
          placeholder={variable.default !== undefined ? String(variable.default) : ''}
        />
      )}
    </div>
  )
}

/** Extract variable definitions from inline YAML in children code blocks */
function parseVariablesFromChildren(children: React.ReactNode): InputVariable[] {
  if (!children) return []

  // Children could be a string or React elements containing code blocks
  // The MDX compiler turns ```yaml ... ``` inside <Inputs> into child elements
  const text = extractTextFromChildren(children)
  if (!text) return []

  try {
    const parsed = yaml.parse(text)
    if (parsed?.variables && Array.isArray(parsed.variables)) {
      return parsed.variables
    }
  } catch {
    // Not valid YAML
  }

  return []
}

function extractTextFromChildren(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node) return ''

  if (Array.isArray(node)) {
    return node.map(extractTextFromChildren).join('')
  }

  if (React.isValidElement(node)) {
    const props = node.props as Record<string, unknown>
    // For code blocks, the text content is in children
    if (props.children) {
      return extractTextFromChildren(props.children as React.ReactNode)
    }
  }

  return ''
}
