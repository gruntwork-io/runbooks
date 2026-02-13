import React from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { BoilerplateVariable } from '@/types/boilerplateVariable'
import { BoilerplateVariableType } from '@/types/boilerplateVariable'

/**
 * Base props interface for all form control components
 */
interface BaseFormControlProps {
  /** The boilerplate variable configuration */
  variable: BoilerplateVariable
  /** Current value of the form field */
  value: unknown
  /** Optional validation error message */
  error?: string
  /** Callback function when the field value changes */
  onChange: (value: unknown) => void
  /** Callback function when the field loses focus (for validation) */
  onBlur?: () => void
  /** Unique identifier for the form field */
  id: string
  /** Whether the field is disabled (read-only) */
  disabled?: boolean
}

/**
 * Generates consistent CSS classes for form inputs with error and disabled state handling
 * @param error - Optional error message to determine error styling
 * @param additionalClasses - Additional CSS classes to append
 * @param disabled - Whether the field is disabled
 * @returns Combined CSS class string
 */
const getInputClassName = (error?: string, additionalClasses = '', disabled = false) => {
  const baseClasses = 'px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500'
  const errorClasses = error ? 'border-red-500' : 'border-gray-300'
  const disabledClasses = disabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'bg-white'
  return `${baseClasses} ${errorClasses} ${disabledClasses} ${additionalClasses}`.trim()
}

/**
 * Text input component for string variables
 * Renders a standard text input field with validation error styling
 */
export const StringInput: React.FC<BaseFormControlProps> = ({ variable, value, error, onChange, onBlur, id, disabled }) => (
  <input
    type="text"
    id={`${id}-${variable.name}`}
    value={String(value || '')}
    onChange={(e) => onChange(e.target.value)}
    onBlur={onBlur}
    disabled={disabled}
    className={getInputClassName(error, 'w-full', disabled)}
  />
)

/**
 * Number input component for integer and float variables
 * Renders a number input field with proper value parsing.
 * Preserves empty values to allow required field validation to work correctly.
 */
export const NumberInput: React.FC<BaseFormControlProps> = ({ variable, value, error, onChange, onBlur, id, disabled }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = e.target.value
    // Preserve empty string to allow required field validation
    if (rawValue === '') {
      onChange('')
      return
    }
    // Parse as number, keeping the numeric value
    const parsed = parseFloat(rawValue)
    onChange(isNaN(parsed) ? '' : parsed)
  }

  // Display empty string for null/undefined, otherwise show the value
  const displayValue = value === null || value === undefined || value === '' ? '' : String(value)

  return (
    <input
      type="number"
      id={`${id}-${variable.name}`}
      value={displayValue}
      onChange={handleChange}
      onBlur={onBlur}
      disabled={disabled}
      className={getInputClassName(error, 'max-w-24', disabled)}
      placeholder=""
    />
  )
}

/**
 * Checkbox input component for boolean variables
 * Renders a checkbox with proper boolean value handling
 */
export const BooleanInput: React.FC<BaseFormControlProps> = ({ variable, value, onChange, onBlur, id, disabled }) => (
  <div className="flex items-center">
    <input
      type="checkbox"
      id={`${id}-${variable.name}`}
      checked={Boolean(value)}
      onChange={(e) => onChange(e.target.checked)}
      onBlur={onBlur}
      disabled={disabled}
      className={`h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    />
  </div>
)

/**
 * Select dropdown component for enum variables
 * Renders a dropdown with predefined options from the variable configuration
 */
export const EnumSelect: React.FC<BaseFormControlProps> = ({ variable, value, error, onChange, onBlur, id, disabled }) => (
  <select
    id={`${id}-${variable.name}`}
    value={String(value || '')}
    onChange={(e) => onChange(e.target.value)}
    onBlur={onBlur}
    disabled={disabled}
    className={getInputClassName(error, 'min-w-56', disabled)}
  >
    {variable.options?.map(option => (
      <option key={option} value={option}>
        {option}
      </option>
    ))}
  </select>
)

/**
 * List input component for array variables
 * Provides functionality to add/remove items from a list with a clean UI
 */
export const ListInput: React.FC<BaseFormControlProps> = ({ value, onChange, onBlur, disabled }) => {
  const currentList = Array.isArray(value) ? value : []
  const inputRef = React.useRef<HTMLInputElement>(null)

  const addItem = (newItem: string) => {
    if (newItem.trim()) {
      onChange([...currentList, newItem.trim()])
    }
  }

  const removeItem = (index: number) => {
    const newList = currentList.filter((_, i) => i !== index)
    onChange(newList)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const input = e.target as HTMLInputElement
      addItem(input.value)
      input.value = ''
    }
  }

  const handleAddClick = () => {
    if (inputRef.current) {
      addItem(inputRef.current.value)
      inputRef.current.value = ''
    }
  }

  return (
    <div className="space-y-3">
      {/* Add entry input - hidden when disabled */}
      {!disabled && (
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            placeholder="Type an entry and press Enter..."
            className={getInputClassName(undefined, 'flex-1 placeholder:text-gray-400')}
            onKeyDown={handleKeyDown}
            onBlur={onBlur}
          />
          <Button
            type="button"
            variant="secondary"
            className="translate translate-y-0.75 text-secondary-foreground"
            onClick={handleAddClick}
          >
            Add
          </Button>
        </div>
      )}

      {/* List items */}
      {currentList.length > 0 && (
        <div className={`border border-gray-200 rounded-md ${disabled ? 'bg-gray-100' : 'bg-white'}`}>
          <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 rounded-t-md">
            <span className="text-sm font-medium text-gray-700">
              {currentList.length} entr{currentList.length !== 1 ? 'ies' : 'y'}
              {disabled && <span className="text-gray-400 ml-2">(inherited)</span>}
            </span>
          </div>
          <div className="divide-y divide-gray-100">
            {currentList.map((item, index) => (
              <div key={index} className={`flex items-center justify-between px-3 py-2 ${disabled ? '' : 'hover:bg-gray-50'} transition-colors`}>
                <span className={`text-sm flex-1 ${disabled ? 'text-gray-500' : 'text-gray-900'}`}>{item}</span>
                {!disabled && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeItem(index)}
                    className="ml-2 text-gray-400 hover:text-red-600 hover:bg-red-50 shadow-none hover:shadow-none active:shadow-none active:translate-y-0"
                    title="Remove entry"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Structured map input component for map variables with a schema
 * Provides a form-based UI for entering structured data with multiple fields per entry
 */
export const StructuredMapInput: React.FC<BaseFormControlProps> = ({ variable, value, onChange, onBlur, disabled }) => {
  const currentMap = typeof value === 'object' && value !== null ? value as Record<string, Record<string, unknown>> : {}
  const [isAddingEntry, setIsAddingEntry] = React.useState(false)
  const [entryKey, setEntryKey] = React.useState('')
  const [entryFields, setEntryFields] = React.useState<Record<string, string>>({})
  
  const schema = variable.schema || {}
  const schemaFields = Object.keys(schema)
  const instanceLabel = variable.schemaInstanceLabel || 'Entry name' // Use custom label or default

  const addEntry = () => {
    if (entryKey.trim()) {
      onChange({ ...currentMap, [entryKey.trim()]: entryFields })
      setEntryKey('')
      setEntryFields({})
      setIsAddingEntry(false)
    }
  }

  const removeEntry = (key: string) => {
    const newMap = { ...currentMap }
    delete newMap[key]
    onChange(newMap)
  }

  const updateField = (fieldName: string, fieldValue: string) => {
    setEntryFields(prev => ({ ...prev, [fieldName]: fieldValue }))
  }

  const entries = Object.entries(currentMap)
  
  return (
    <div className="space-y-3">
      {/* Add entry button/form - hidden when disabled */}
      {!disabled && !isAddingEntry ? (
        <Button
          type="button"
          variant="secondary"
          className="text-secondary-foreground"
          onClick={() => setIsAddingEntry(true)}
        >
          Add
        </Button>
      ) : !disabled && isAddingEntry ? (
        <div className="border border-gray-300 rounded-md p-4 bg-gray-50 space-y-3">
          <div className="flex justify-between items-center mb-2">
            <h4 className="font-medium text-sm text-gray-700">New Entry</h4>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsAddingEntry(false)
                setEntryKey('')
                setEntryFields({})
              }}
              className="text-gray-500 hover:text-gray-700"
            >
              Cancel
            </Button>
          </div>
          
          {/* Entry key input */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {instanceLabel} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={entryKey}
              onChange={(e) => setEntryKey(e.target.value)}
              onBlur={onBlur}
              className={getInputClassName(undefined, 'w-full')}
            />
          </div>

          {/* Schema fields */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Fields</label>
            {schemaFields.map((fieldName) => {
              const fieldType = schema[fieldName]
              return (
                <div key={fieldName}>
                  <label className="block text-xs text-gray-600 mb-1">
                    {fieldName} <span className="text-gray-400">({fieldType})</span>
                  </label>
                  {fieldType === 'bool' ? (
                    <select
                      value={entryFields[fieldName] || 'false'}
                      onChange={(e) => updateField(fieldName, e.target.value)}
                      className={getInputClassName(undefined, 'w-full')}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : fieldType === 'number' || fieldType === 'int' || fieldType === 'float' ? (
                    <input
                      type="number"
                      value={entryFields[fieldName] || ''}
                      onChange={(e) => updateField(fieldName, e.target.value)}
                      className={getInputClassName(undefined, 'w-full')}
                    />
                  ) : (
                    <input
                      type="text"
                      value={entryFields[fieldName] || ''}
                      onChange={(e) => updateField(fieldName, e.target.value)}
                      className={getInputClassName(undefined, 'w-full')}
                    />
                  )}
                </div>
              )
            })}
          </div>

          <Button
            type="button"
            variant="default"
            onClick={addEntry}
            disabled={!entryKey.trim()}
            className="w-full"
          >
            Save Entry
          </Button>
        </div>
      ) : null}
      
      {/* Map entries */}
      {entries.length > 0 ? (
        <div className={`border border-gray-200 rounded-md ${disabled ? 'bg-gray-100' : 'bg-white'}`}>
          <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 rounded-t-md">
            <span className="text-sm font-medium text-gray-700">
              {entries.length} entr{entries.length !== 1 ? 'ies' : 'y'}
              {disabled && <span className="text-gray-400 ml-2">(inherited)</span>}
            </span>
          </div>
          <div className="divide-y divide-gray-100">
            {entries.map(([key, val]) => (
              <div key={key} className={`px-3 py-2 ${disabled ? '' : 'hover:bg-gray-50'} transition-colors`}>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className={`font-medium text-sm mb-1 ${disabled ? 'text-gray-500' : 'text-gray-900'}`}>{key}</div>
                    <div className="text-xs text-gray-600 space-y-0.5">
                      {typeof val === 'object' && val !== null ? (
                        Object.entries(val as Record<string, unknown>).map(([fieldKey, fieldVal]) => (
                          <div key={fieldKey}>
                            <span className="font-medium">{fieldKey}:</span> {String(fieldVal)}
                          </div>
                        ))
                      ) : (
                        <div>{String(val)}</div>
                      )}
                    </div>
                  </div>
                  {!disabled && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeEntry(key)}
                      className="ml-2 text-gray-400 hover:text-red-600 hover:bg-red-50 shadow-none hover:shadow-none active:shadow-none active:translate-y-0"
                      title="Remove entry"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : !disabled ? (
        <div className="text-center py-4 text-gray-500 text-sm border border-gray-200 rounded-md bg-gray-50">
          No entries added yet. Click "Add Entry" above to get started.
        </div>
      ) : null}
    </div>
  )
}

/**
 * Map input component for object variables
 * Provides functionality to add/remove key-value pairs with a clean UI
 */
export const MapInput: React.FC<BaseFormControlProps> = ({ variable, value, onChange, onBlur, id, disabled }) => {
  const currentMap = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  
  const addEntry = (key: string, val: string) => {
    if (key.trim() && val.trim()) {
      onChange({ ...currentMap, [key.trim()]: val.trim() })
    }
  }

  const removeEntry = (key: string) => {
    const newMap = { ...currentMap }
    delete newMap[key]
    onChange(newMap)
  }

  const handleAddClick = () => {
    const keyInput = document.getElementById(`${id}-${variable.name}-key`) as HTMLInputElement
    const valueInput = document.getElementById(`${id}-${variable.name}-value`) as HTMLInputElement
    if (keyInput && valueInput) {
      addEntry(keyInput.value, valueInput.value)
      keyInput.value = ''
      valueInput.value = ''
    }
  }

  const entries = Object.entries(currentMap)
  
  return (
    <div className="space-y-3">
      {/* Add entry input - hidden when disabled */}
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            placeholder="Key"
            className={getInputClassName(undefined, 'flex-1 placeholder:text-gray-400')}
            id={`${id}-${variable.name}-key`}
            onBlur={onBlur}
          />
          <input
            type="text"
            placeholder="Value"
            className={getInputClassName(undefined, 'flex-1 placeholder:text-gray-400')}
            id={`${id}-${variable.name}-value`}
            onBlur={onBlur}
          />
          <Button
            type="button"
            variant="secondary"
            className="translate translate-y-0.75 text-secondary-foreground"
            onClick={handleAddClick}
          >
            Add
          </Button>
        </div>
      )}

      {/* Map entries */}
      {entries.length > 0 ? (
        <div className={`border border-gray-200 rounded-md ${disabled ? 'bg-gray-100' : 'bg-white'}`}>
          <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 rounded-t-md">
            <span className="text-sm font-medium text-gray-700">
              {entries.length} entr{entries.length !== 1 ? 'ies' : 'y'}
              {disabled && <span className="text-gray-400 ml-2">(inherited)</span>}
            </span>
          </div>
          <div className="divide-y divide-gray-100">
            {entries.map(([key, val]) => (
              <div key={key} className={`flex items-center justify-between px-3 py-2 ${disabled ? '' : 'hover:bg-gray-50'} transition-colors`}>
                <span className={`text-sm flex-1 ${disabled ? 'text-gray-500' : 'text-gray-900'}`}><strong>{key}:</strong> {String(val)}</span>
                {!disabled && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeEntry(key)}
                    className="ml-2 text-gray-400 hover:text-red-600 hover:bg-red-50 shadow-none hover:shadow-none active:shadow-none active:translate-y-0"
                    title="Remove entry"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : !disabled ? (
        <div className="text-center py-4 text-gray-500 text-sm border border-gray-200 rounded-md bg-gray-50">
          No entries added yet. Add key-value pairs above to get started.
        </div>
      ) : null}
    </div>
  )
}

/**
 * Tuple input component for fixed-length typed arrays (e.g. tuple([string, number]))
 * Renders one input per element with the appropriate type based on the schema.
 * Schema keys are numeric indices ("0", "1", ...) mapping to element types.
 */
export const TupleInput: React.FC<BaseFormControlProps> = ({ variable, value, error, onChange, onBlur, id, disabled }) => {
  const schema = variable.schema || {}
  // Sort keys numerically to preserve element order
  const elementKeys = Object.keys(schema).sort((a, b) => Number(a) - Number(b))
  const currentTuple = Array.isArray(value) ? value : new Array(elementKeys.length).fill('')

  const updateElement = (index: number, newValue: unknown) => {
    const updated = [...currentTuple]
    updated[index] = newValue
    onChange(updated)
  }

  return (
    <div className="flex flex-wrap gap-2 items-end">
      {elementKeys.map((key) => {
        const index = Number(key)
        const elemType = schema[key]
        const elemValue = currentTuple[index] ?? ''
        const elemLabel = elemType === 'number' ? 'Enter a number'
          : elemType === 'bool' ? 'Enter a boolean'
          : `Enter a ${elemType}`

        return (
          <div key={key} className="flex-1 min-w-24">
            <label className="block text-xs text-gray-500 mb-1">{elemLabel}</label>
            {elemType === 'number' ? (
              <input
                type="number"
                id={`${id}-${variable.name}-${key}`}
                value={elemValue === '' ? '' : String(elemValue)}
                onChange={(e) => {
                  const raw = e.target.value
                  updateElement(index, raw === '' ? '' : parseFloat(raw))
                }}
                onBlur={onBlur}
                disabled={disabled}
                className={getInputClassName(error, 'w-full', disabled)}
              />
            ) : elemType === 'bool' ? (
              <select
                id={`${id}-${variable.name}-${key}`}
                value={String(elemValue || 'false')}
                onChange={(e) => updateElement(index, e.target.value === 'true')}
                onBlur={onBlur}
                disabled={disabled}
                className={getInputClassName(error, 'w-full', disabled)}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                type="text"
                id={`${id}-${variable.name}-${key}`}
                value={String(elemValue || '')}
                onChange={(e) => updateElement(index, e.target.value)}
                onBlur={onBlur}
                disabled={disabled}
                className={getInputClassName(error, 'w-full', disabled)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Main form control component that renders the appropriate input type
 * based on the variable type. Acts as a factory for different input components.
 */
export const FormControl: React.FC<BaseFormControlProps> = (props) => {
  const { variable } = props

  switch (variable.type) {
    case BoilerplateVariableType.String:
      return <StringInput {...props} />
    case BoilerplateVariableType.Int:
    case BoilerplateVariableType.Float:
      return <NumberInput {...props} />
    case BoilerplateVariableType.Bool:
      return <BooleanInput {...props} />
    case BoilerplateVariableType.Enum:
      return <EnumSelect {...props} />
    case BoilerplateVariableType.List:
      // Use tuple input if schema is defined (numeric keys = fixed-length typed array)
      return variable.schema && Object.keys(variable.schema).length > 0
        ? <TupleInput {...props} />
        : <ListInput {...props} />
    case BoilerplateVariableType.Map:
      // Use structured input if schema is defined, otherwise use simple key-value input
      return variable.schema && Object.keys(variable.schema).length > 0
        ? <StructuredMapInput {...props} />
        : <MapInput {...props} />
    default:
      return <StringInput {...props} />
  }
}
