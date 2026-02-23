import React from 'react'
import type { Variable } from '../../../shared/types'

interface VariableInputProps {
  variable: Variable
  value: unknown
  onChange: (value: unknown) => void
}

export function VariableInput({ variable, value, onChange }: VariableInputProps) {
  const isRequired = variable.validations.some((v) => v.type === 'required')

  return (
    <div className="space-y-1">
      <label className="flex items-center gap-1.5 text-sm font-medium text-neutral-700">
        {variable.name}
        {isRequired && <span className="text-red-500">*</span>}
        <span className="text-xs text-neutral-400 font-normal">({variable.type})</span>
      </label>
      {variable.description && (
        <p className="text-xs text-neutral-500">{variable.description}</p>
      )}
      <InputForType variable={variable} value={value} onChange={onChange} />
    </div>
  )
}

function InputForType({
  variable,
  value,
  onChange,
}: {
  variable: Variable
  value: unknown
  onChange: (value: unknown) => void
}) {
  const baseClasses =
    'w-full px-3 py-1.5 text-sm border border-neutral-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white'

  switch (variable.type) {
    case 'bool':
      return (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-neutral-600">
            {value ? 'true' : 'false'}
          </span>
        </div>
      )

    case 'enum':
      return (
        <select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={baseClasses}
        >
          <option value="">-- Select --</option>
          {variable.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      )

    case 'int':
      return (
        <input
          type="number"
          step="1"
          value={value === '' || value === undefined || value === null ? '' : String(value)}
          onChange={(e) => {
            const v = e.target.value
            onChange(v === '' ? '' : parseInt(v, 10))
          }}
          className={baseClasses}
          placeholder={`Enter an integer${variable.default !== undefined ? ` (default: ${variable.default})` : ''}`}
        />
      )

    case 'float':
      return (
        <input
          type="number"
          step="any"
          value={value === '' || value === undefined || value === null ? '' : String(value)}
          onChange={(e) => {
            const v = e.target.value
            onChange(v === '' ? '' : parseFloat(v))
          }}
          className={baseClasses}
          placeholder={`Enter a number${variable.default !== undefined ? ` (default: ${variable.default})` : ''}`}
        />
      )

    case 'list':
      return (
        <ListInput
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
        />
      )

    case 'map':
      return (
        <MapInput
          value={typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, string> : {}}
          onChange={onChange}
        />
      )

    case 'string':
    default:
      return (
        <input
          type="text"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={baseClasses}
          placeholder={
            variable.default !== undefined
              ? `Default: ${variable.default}`
              : `Enter ${variable.name}`
          }
        />
      )
  }
}

function ListInput({
  value,
  onChange,
}: {
  value: unknown[]
  onChange: (value: unknown[]) => void
}) {
  const items = value.map(String)

  return (
    <div className="space-y-1">
      {items.map((item, index) => (
        <div key={index} className="flex gap-1">
          <input
            type="text"
            value={item}
            onChange={(e) => {
              const newItems = [...items]
              newItems[index] = e.target.value
              onChange(newItems)
            }}
            className="flex-1 px-3 py-1.5 text-sm border border-neutral-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={() => onChange(items.filter((_, i) => i !== index))}
            className="px-2 text-neutral-400 hover:text-red-500"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...items, ''])}
        className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
        Add item
      </button>
    </div>
  )
}

function MapInput({
  value,
  onChange,
}: {
  value: Record<string, string>
  onChange: (value: Record<string, string>) => void
}) {
  const entries = Object.entries(value)

  return (
    <div className="space-y-1">
      {entries.map(([key, val], index) => (
        <div key={index} className="flex gap-1">
          <input
            type="text"
            value={key}
            placeholder="key"
            onChange={(e) => {
              const newEntries = [...entries]
              newEntries[index] = [e.target.value, val]
              onChange(Object.fromEntries(newEntries))
            }}
            className="w-1/3 px-3 py-1.5 text-sm border border-neutral-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="text"
            value={val}
            placeholder="value"
            onChange={(e) => {
              const newEntries = [...entries]
              newEntries[index] = [key, e.target.value]
              onChange(Object.fromEntries(newEntries))
            }}
            className="flex-1 px-3 py-1.5 text-sm border border-neutral-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={() => {
              const newMap = { ...value }
              delete newMap[key]
              onChange(newMap)
            }}
            className="px-2 text-neutral-400 hover:text-red-500"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange({ ...value, '': '' })}
        className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
        Add entry
      </button>
    </div>
  )
}
