import React, { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { BoilerplateVariableType } from './BoilerplateInputs.types'
import type { BoilerplateVariable, BoilerplateInputsFormProps } from './BoilerplateInputs.types'
import { formatVariableLabel } from './formatVariableLabel'

export const BoilerplateInputsForm: React.FC<BoilerplateInputsFormProps> = ({
  id,
  boilerplateConfig,
  initialData = {},
  onFormChange,
  onSubmit,
  submitButtonText = 'Generate',
  showSubmitButton = true
}) => {
  // Declare state variables
  const [formData, setFormData] = useState<Record<string, unknown>>({})
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})

  // Initialize form data with defaults and initial values
  useEffect(() => {
    if (!boilerplateConfig) return
    
    const initialFormData: Record<string, unknown> = {}
    
    boilerplateConfig.variables.forEach((variable: BoilerplateVariable) => {
      initialFormData[variable.name] = initialData[variable.name] ?? variable.default
    })
    
    setFormData(initialFormData)
  }, [boilerplateConfig, initialData])

  // Notify parent component when form data changes
  useEffect(() => {
    if (onFormChange) {
      onFormChange(formData)
    }
  }, [formData, onFormChange])

  // Handle form input changes
  const handleInputChange = (variableName: string, value: unknown) => {
    setFormData(prev => ({
      ...prev,
      [variableName]: value
    }))
    
    // Clear validation error for this field
    if (validationErrors[variableName]) {
      setValidationErrors(prev => {
        const newErrors = { ...prev }
        delete newErrors[variableName]
        return newErrors
      })
    }
  }

  // Validate form
  const validateForm = (): boolean => {
    if (!boilerplateConfig) return false
    
    const errors: Record<string, string> = {}
    let isValid = true
    
    boilerplateConfig.variables.forEach((variable: BoilerplateVariable) => {
      const value = formData[variable.name]
      if (variable.required && (value === undefined || value === null || value === '')) {
        errors[variable.name] = `${variable.name} is required`
        isValid = false
      }
    })
    
    setValidationErrors(errors)
    return isValid
  }

  // Handle form submission
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!validateForm()) {
      return
    }
    
    if (onSubmit) {
      onSubmit(formData)
    }
  }

  // Render form control based on variable type
  const renderFormControl = (variable: BoilerplateVariable) => {
    const value = formData[variable.name]
    const error = validationErrors[variable.name]
    
    switch (variable.type) {
      case BoilerplateVariableType.String:
        return (
          <input
            type="text"
            id={`${id}-${variable.name}`}
            value={String(value || '')}
            onChange={(e) => handleInputChange(variable.name, e.target.value)}
            className={`w-full bg-white px-3 py-2 border rounded-xs focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              error ? 'border-red-500' : 'border-gray-300'
            }`}
          />
        )
      
      case BoilerplateVariableType.Int:
      case BoilerplateVariableType.Float:
        return (
          <input
            type="number"
            id={`${id}-${variable.name}`}
            value={String(value || '')}
            onChange={(e) => handleInputChange(variable.name, parseFloat(e.target.value) || 0)}
            className={`bg-white max-w-24 px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              error ? 'border-red-500' : 'border-gray-300'
            }`}
            placeholder={variable.description}
          />
        )
      
      case BoilerplateVariableType.Bool:
        return (
          <div className="flex items-center">
            <input
              type="checkbox"
              id={`${id}-${variable.name}`}
              checked={Boolean(value)}
              onChange={(e) => handleInputChange(variable.name, e.target.checked)}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            
          </div>
        )
      
      case BoilerplateVariableType.Enum:
        return (
          <select
            id={`${id}-${variable.name}`}
            value={String(value || '')}
            onChange={(e) => handleInputChange(variable.name, e.target.value)}
            className={`min-w-56 bg-white px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              error ? 'border-red-500' : 'border-gray-300'
            }`}
          >
            {variable.options?.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )
      
      case BoilerplateVariableType.List:
        return (
          <div className="space-y-3">
            {/* Add entry input */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Type an entry and press Enter..."
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white placeholder:text-gray-400"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const input = e.target as HTMLInputElement
                    const newItem = input.value.trim()
                    if (newItem) {
                      const currentList = Array.isArray(value) ? value : []
                      handleInputChange(variable.name, [...currentList, newItem])
                      input.value = ''
                    }
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  const input = document.querySelector(`input[placeholder*="Type an entry"]`) as HTMLInputElement
                  if (input) {
                    const newItem = input.value.trim()
                    if (newItem) {
                      const currentList = Array.isArray(value) ? value : []
                      handleInputChange(variable.name, [...currentList, newItem])
                      input.value = ''
                    }
                  }
                }}
                className="px-4 py-2 bg-gray-300 cursor-pointer hover:bg-gray-400 bg-opacity-40 rounded-md  focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
              >
                Add
              </button>
            </div>
            
            {/* List items */}
            {Array.isArray(value) && value.length > 0 && (
              <div className="border border-gray-200 rounded-md bg-white">
                <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 rounded-t-md">
                  <span className="text-sm font-medium text-gray-700">
                    {value.length} entr{value.length !== 1 ? 'ies' : 'y'}
                  </span>
                </div>
                <div className="divide-y divide-gray-100">
                  {value.map((item, index) => (
                    <div key={index} className="flex items-center justify-between px-3 py-2 hover:bg-gray-50 transition-colors">
                      <span className="text-sm text-gray-900 flex-1">{item}</span>
                      <button
                        type="button"
                        onClick={() => {
                          const newList = value.filter((_, i) => i !== index)
                          handleInputChange(variable.name, newList)
                        }}
                        className="ml-2 p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors cursor-pointer"
                        title="Remove entry"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      
      case BoilerplateVariableType.Map:
        return (
          <div className="space-y-3">
            {/* Add entry input */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Key"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white placeholder:text-gray-400"
                id={`${id}-${variable.name}-key`}
              />
              <input
                type="text"
                placeholder="Value"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white placeholder:text-gray-400"
                id={`${id}-${variable.name}-value`}
              />
              <button
                type="button"
                onClick={() => {
                  const keyInput = document.getElementById(`${id}-${variable.name}-key`) as HTMLInputElement
                  const valueInput = document.getElementById(`${id}-${variable.name}-value`) as HTMLInputElement
                  const key = keyInput.value.trim()
                  const val = valueInput.value.trim()
                  if (key && val) {
                    const currentMap = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
                    handleInputChange(variable.name, { ...currentMap, [key]: val })
                    keyInput.value = ''
                    valueInput.value = ''
                  }
                }}
                className="px-4 py-2 bg-gray-300 cursor-pointer hover:bg-gray-400 bg-opacity-40 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
              >
                Add
              </button>
            </div>
            
            {/* Map entries */}
            {typeof value === 'object' && value !== null && Object.keys(value).length > 0 && (
              <div className="border border-gray-200 rounded-md bg-white">
                <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 rounded-t-md">
                  <span className="text-sm font-medium text-gray-700">
                    {Object.keys(value).length} entr{Object.keys(value).length !== 1 ? 'ies' : 'y'}
                  </span>
                </div>
                <div className="divide-y divide-gray-100">
                  {Object.entries(value).map(([key, val]) => (
                    <div key={key} className="flex items-center justify-between px-3 py-2 hover:bg-gray-50 transition-colors">
                      <span className="text-sm text-gray-900 flex-1"><strong>{key}:</strong> {String(val)}</span>
                      <button
                        type="button"
                        onClick={() => {
                          const newMap = { ...(value as Record<string, unknown>) }
                          delete newMap[key]
                          handleInputChange(variable.name, newMap)
                        }}
                        className="ml-2 p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors cursor-pointer"
                        title="Remove entry"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {/* Empty state */}
            {(!value || typeof value !== 'object' || Object.keys(value).length === 0) && (
              <div className="text-center py-4 text-gray-500 text-sm border border-gray-200 rounded-md bg-gray-50">
                No entries added yet. Add key-value pairs above to get started.
              </div>
            )}
          </div>
        )
      
      default:
        return (
          <input
            type="text"
            id={`${id}-${variable.name}`}
            value={String(value || '')}
            onChange={(e) => handleInputChange(variable.name, e.target.value)}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              error ? 'border-red-500' : 'border-gray-300'
            }`}
            placeholder={variable.description}
          />
        )
    }
  }

  return (
    <div className="p-6 border border-gray-200 rounded-lg shadow-sm bg-gray-100">
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-5">
          {boilerplateConfig!.variables.map((variable: BoilerplateVariable) => (
            <div key={variable.name} className="space-y-1">
              <label 
                htmlFor={`${id}-${variable.name}`}
                className="block text-md font-medium text-gray-700"
              >
                {formatVariableLabel(variable.name)}
                {variable.required && <span className="text-red-500 ml-1">*</span>}
              </label>
              
              {renderFormControl(variable)}

              {variable.description && (
                <p className="text-sm text-gray-400">{variable.description}</p>
              )}
              
              {validationErrors[variable.name] && (
                <p className="text-sm text-red-600">{validationErrors[variable.name]}</p>
              )}
            </div>
          ))}
        </div>
        
        {showSubmitButton && (
          <div className="pt-4 border-t border-gray-200">
            <button
              type="submit"
              className="w-full px-4 py-2 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              {submitButtonText}
            </button>
          </div>
        )}
      </form>
    </div>
  )
}
