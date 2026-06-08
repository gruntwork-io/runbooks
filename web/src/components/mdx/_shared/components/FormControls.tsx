import React from 'react'
import { X, Eye, EyeOff, Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
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
  const baseClasses = 'px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring'
  const errorClasses = error ? 'border-destructive' : 'border-input'
  const disabledClasses = disabled ? 'bg-muted text-muted-foreground cursor-not-allowed' : 'bg-card'
  return `${baseClasses} ${errorClasses} ${disabledClasses} ${additionalClasses}`.trim()
}

/** Header row showing the entry count (and an "(inherited)" badge when disabled). */
const EntryCountHeader: React.FC<{ count: number; disabled?: boolean }> = ({ count, disabled }) => (
  <div className="px-3 py-2 bg-muted border-b border-border rounded-t-md">
    <span className="text-sm font-medium text-foreground">
      {count} entr{count !== 1 ? 'ies' : 'y'}
      {disabled && <span className="text-muted-foreground ml-2">(inherited)</span>}
    </span>
  </div>
)

/** Ghost icon button for removing a list/map entry. */
const RemoveEntryButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <Button
    type="button"
    variant="ghost"
    size="icon"
    onClick={onClick}
    className="ml-2 text-muted-foreground hover:text-destructive hover:bg-destructive-muted shadow-none hover:shadow-none active:shadow-none active:translate-y-0"
    title="Remove entry"
  >
    <X className="w-4 h-4" />
  </Button>
)

/**
 * Text input component for string variables
 * Renders a standard text input field with validation error styling
 */
export const StringInput: React.FC<BaseFormControlProps> = ({ variable, value, error, onChange, onBlur, id, disabled }) => {
  const [showSensitive, setShowSensitive] = React.useState(false)

  if (variable.sensitive) {
    return (
      <div className="relative">
        <input
          type={showSensitive ? 'text' : 'password'}
          id={`${id}-${variable.name}`}
          value={String(value || '')}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          disabled={disabled}
          className={getInputClassName(error, 'w-full pr-10', disabled)}
        />
        <button
          type="button"
          onClick={() => setShowSensitive(!showSensitive)}
          aria-label={showSensitive ? 'Hide sensitive input' : 'Show sensitive input'}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
        >
          {showSensitive ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    )
  }

  return (
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
}

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
      className={`h-4 w-4 text-primary focus:ring-ring border-input rounded ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
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
            className={getInputClassName(undefined, 'flex-1 placeholder:text-muted-foreground')}
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
        <div className={`border border-border rounded-md ${disabled ? 'bg-muted' : 'bg-card'}`}>
          <EntryCountHeader count={currentList.length} disabled={disabled} />
          <div className="divide-y divide-border">
            {currentList.map((item, index) => (
              <div key={index} className={`flex items-center justify-between px-3 py-2 ${disabled ? '' : 'hover:bg-accent'} transition-colors`}>
                <span className={`text-sm flex-1 ${disabled ? 'text-muted-foreground' : 'text-foreground'}`}>{item}</span>
                {!disabled && <RemoveEntryButton onClick={() => removeItem(index)} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Multi-select input for `list` variables that declare an enumerated option set (via the boilerplate.yml
 * `x-options` extension, surfaced as `variable.options`). Renders a searchable popover of checkable options and
 * keeps the selection in the canonical option order. The value is a plain `string[]` — identical on the wire to a
 * freeform list — so Boilerplate renders it unchanged. Membership is enforced only by the UI (the picker never
 * offers a value outside the option set); there is no Go-side constraint.
 */
export const MultiSelectInput: React.FC<BaseFormControlProps> = ({ variable, value, onChange, onBlur, id, disabled }) => {
  const options = variable.options ?? []
  const selected = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  const selectedSet = new Set(selected)
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const listRef = React.useRef<HTMLDivElement>(null)

  // Scroll to the top whenever the search changes or the popover opens (matches DefaultRegionPicker).
  React.useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTo({ top: 0 })
    }
  }, [open, search])

  const toggle = (option: string) => {
    if (selectedSet.has(option)) {
      onChange(selected.filter((o) => o !== option))
    } else {
      // Keep the selection in the canonical option order rather than click order.
      onChange(options.filter((o) => selectedSet.has(o) || o === option))
    }
  }

  const removeItem = (option: string) => onChange(selected.filter((o) => o !== option))

  return (
    <div className="space-y-2">
      {!disabled && (
        <Popover
          open={open}
          onOpenChange={(isOpen) => {
            setOpen(isOpen)
            if (!isOpen) {
              setSearch('')
              onBlur?.()
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              id={`${id}-${variable.name}`}
              className="w-full justify-between font-normal bg-card border-input hover:bg-accent"
            >
              {selected.length > 0 ? `${selected.length} selected` : 'Select options...'}
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[400px] p-0" align="start" side="bottom" avoidCollisions={false}>
            <Command>
              <CommandInput placeholder="Search options..." value={search} onValueChange={setSearch} />
              <CommandList ref={listRef} className="max-h-[300px]">
                <CommandEmpty>No match found.</CommandEmpty>
                <CommandGroup>
                  {options.map((option) => (
                    <CommandItem
                      key={option}
                      value={option}
                      onSelect={() => toggle(option)}
                      className="flex items-center gap-2"
                    >
                      <Check
                        className={cn(
                          'h-4 w-4 shrink-0',
                          selectedSet.has(option) ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <span className="font-mono text-xs text-foreground">{option}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}

      {/* Selected entries, always visible so the choice is readable without opening the picker. */}
      {selected.length > 0 && (
        <div className={`border border-border rounded-md ${disabled ? 'bg-muted' : 'bg-card'}`}>
          <EntryCountHeader count={selected.length} disabled={disabled} />
          <div className="flex flex-wrap gap-1.5 p-2">
            {selected.map((option) => (
              <span
                key={option}
                className={`inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 font-mono text-xs ${disabled ? 'text-muted-foreground' : 'text-foreground'}`}
              >
                {option}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => removeItem(option)}
                    className="text-muted-foreground hover:text-destructive cursor-pointer rounded-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    title={`Remove ${option}`}
                    aria-label={`Remove ${option}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </span>
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
export const StructuredMapInput: React.FC<BaseFormControlProps> = ({ variable, value, onChange, onBlur, id, disabled }) => {
  const currentMap = typeof value === 'object' && value !== null ? value as Record<string, Record<string, unknown>> : {}
  const [isAddingEntry, setIsAddingEntry] = React.useState(false)
  const [entryKey, setEntryKey] = React.useState('')
  const [entryFields, setEntryFields] = React.useState<Record<string, string>>({})
  
  const schema = variable.schema || {}
  const schemaFields = Object.keys(schema)
  const instanceLabel = variable.schemaInstanceLabel || 'Entry name'
  const entryKeyId = `${id}-${variable.name}-entry-key`

  const resetEntryForm = () => {
    setIsAddingEntry(false)
    setEntryKey('')
    setEntryFields({})
  }

  const addEntry = () => {
    if (entryKey.trim()) {
      onChange({ ...currentMap, [entryKey.trim()]: entryFields })
      resetEntryForm()
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
        <div className="border border-border rounded-md p-4 bg-muted space-y-3">
          <div className="flex justify-between items-center mb-2">
            <h4 className="font-medium text-sm text-foreground">New Entry</h4>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetEntryForm}
              className="text-muted-foreground hover:text-foreground"
            >
              Cancel
            </Button>
          </div>
          
          {/* Entry key input */}
          <div>
            <label htmlFor={entryKeyId} className="block text-sm font-medium text-foreground mb-1">
              {instanceLabel} <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              id={entryKeyId}
              value={entryKey}
              onChange={(e) => setEntryKey(e.target.value)}
              onBlur={onBlur}
              className={getInputClassName(undefined, 'w-full')}
            />
          </div>

          {/* Schema fields */}
          <div className="space-y-2">
            <span className="block text-sm font-medium text-foreground mb-1">Fields</span>
            {schemaFields.map((fieldName) => {
              const fieldType = schema[fieldName]
              // Include variable.name to ensure global uniqueness, a requirement with htmlFor attributes — multiple structured maps can share schema field names (e.g., "email").
              const fieldId = `${id}-${variable.name}-field-${fieldName}`
              return (
                <div key={fieldName}>
                  <label htmlFor={fieldId} className="block text-xs text-muted-foreground mb-1">
                    {fieldName} <span className="text-muted-foreground">({fieldType})</span>
                  </label>
                  {fieldType === 'bool' ? (
                    <select
                      id={fieldId}
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
                      id={fieldId}
                      value={entryFields[fieldName] || ''}
                      onChange={(e) => updateField(fieldName, e.target.value)}
                      className={getInputClassName(undefined, 'w-full')}
                    />
                  ) : (
                    <input
                      type="text"
                      id={fieldId}
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
        <div className={`border border-border rounded-md ${disabled ? 'bg-muted' : 'bg-card'}`}>
          <EntryCountHeader count={entries.length} disabled={disabled} />
          <div className="divide-y divide-border">
            {entries.map(([key, val]) => (
              <div key={key} className={`px-3 py-2 ${disabled ? '' : 'hover:bg-accent'} transition-colors`}>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className={`font-medium text-sm mb-1 ${disabled ? 'text-muted-foreground' : 'text-foreground'}`}>{key}</div>
                    <div className="text-xs text-muted-foreground space-y-0.5">
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
                  {!disabled && <RemoveEntryButton onClick={() => removeEntry(key)} />}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : !disabled ? (
        <div className="text-center py-4 text-muted-foreground text-sm border border-border rounded-md bg-muted">
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
            className={getInputClassName(undefined, 'flex-1 placeholder:text-muted-foreground')}
            id={`${id}-${variable.name}-key`}
            onBlur={onBlur}
          />
          <input
            type="text"
            placeholder="Value"
            className={getInputClassName(undefined, 'flex-1 placeholder:text-muted-foreground')}
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
        <div className={`border border-border rounded-md ${disabled ? 'bg-muted' : 'bg-card'}`}>
          <EntryCountHeader count={entries.length} disabled={disabled} />
          <div className="divide-y divide-border">
            {entries.map(([key, val]) => (
              <div key={key} className={`flex items-center justify-between px-3 py-2 ${disabled ? '' : 'hover:bg-accent'} transition-colors`}>
                <span className={`text-sm flex-1 ${disabled ? 'text-muted-foreground' : 'text-foreground'}`}><strong>{key}:</strong> {String(val)}</span>
                {!disabled && <RemoveEntryButton onClick={() => removeEntry(key)} />}
              </div>
            ))}
          </div>
        </div>
      ) : !disabled ? (
        <div className="text-center py-4 text-muted-foreground text-sm border border-border rounded-md bg-muted">
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
  const currentTuple = Array.isArray(value) ? value : Array.from({ length: elementKeys.length }, () => '')

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
        const isNumeric = elemType === 'number' || elemType === 'int' || elemType === 'float'
        const elemLabel = isNumeric ? `Enter ${elemType === 'int' ? 'an integer' : elemType === 'float' ? 'a float' : 'a number'}`
          : elemType === 'bool' ? 'Enter a boolean'
          : `Enter a ${elemType}`

        return (
          <div key={key} className="flex-1 min-w-24">
            <label className="block text-xs text-muted-foreground mb-1">{elemLabel}</label>
            {isNumeric ? (
              <input
                type="number"
                id={`${id}-${variable.name}-${key}`}
                value={elemValue === '' ? '' : String(elemValue)}
                onChange={(e) => {
                  const raw = e.target.value
                  updateElement(index, raw === '' ? '' : elemType === 'int' ? parseInt(raw, 10) : parseFloat(raw))
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
      // A list with an enumerated option set (x-options) renders as a multi-select picker.
      if (variable.options && variable.options.length > 0) {
        return <MultiSelectInput {...props} />
      }
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
