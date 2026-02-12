import { useState, useRef, useEffect, useCallback } from "react"
import { X, Loader2, ChevronDown } from "lucide-react"
import type { GitHubLabel } from "../types"

interface LabelSelectorProps {
  selectedLabels: string[]
  onLabelsChange: (labels: string[]) => void
  availableLabels: GitHubLabel[]
  loading?: boolean
  disabled?: boolean
}

export function LabelSelector({
  selectedLabels,
  onLabelsChange,
  availableLabels,
  loading = false,
  disabled = false,
}: LabelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [filter, setFilter] = useState("")
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        setFilter("")
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const handleToggleLabel = useCallback((labelName: string) => {
    if (selectedLabels.includes(labelName)) {
      onLabelsChange(selectedLabels.filter(l => l !== labelName))
    } else {
      onLabelsChange([...selectedLabels, labelName])
    }
  }, [selectedLabels, onLabelsChange])

  const handleRemoveLabel = useCallback((labelName: string) => {
    onLabelsChange(selectedLabels.filter(l => l !== labelName))
  }, [selectedLabels, onLabelsChange])

  const filteredLabels = availableLabels.filter(label =>
    label.name.toLowerCase().includes(filter.toLowerCase())
  )

  const getLabelByName = (name: string) => availableLabels.find(l => l.name === name)

  return (
    <div ref={containerRef} className="relative">
      {/* Selected labels + input */}
      <div
        onClick={() => {
          if (!disabled) {
            setIsOpen(true)
            setTimeout(() => inputRef.current?.focus(), 0)
          }
        }}
        className={`flex flex-wrap items-center gap-1.5 min-h-[38px] px-2 py-1.5 border border-gray-300 rounded-md bg-white cursor-text ${
          disabled ? 'bg-gray-100 cursor-not-allowed' : 'hover:border-gray-400'
        } ${isOpen ? 'ring-2 ring-blue-500 border-blue-500' : ''}`}
      >
        {selectedLabels.map(name => {
          const label = getLabelByName(name)
          return (
            <span
              key={name}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700"
            >
              {label && (
                <span
                  className="size-2 rounded-full shrink-0"
                  style={{ backgroundColor: `#${label.color}` }}
                />
              )}
              {name}
              {!disabled && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleRemoveLabel(name)
                  }}
                  className="text-gray-400 hover:text-gray-600 cursor-pointer"
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          )
        })}
        <input
          ref={inputRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onFocus={() => !disabled && setIsOpen(true)}
          placeholder={selectedLabels.length === 0 ? "Select labels..." : ""}
          disabled={disabled}
          className="flex-1 min-w-[80px] text-sm border-none outline-none bg-transparent placeholder:text-gray-400 disabled:cursor-not-allowed"
        />
        {loading ? (
          <Loader2 className="size-4 text-gray-400 animate-spin shrink-0" />
        ) : (
          <ChevronDown className="size-4 text-gray-400 shrink-0" />
        )}
      </div>

      {/* Dropdown */}
      {isOpen && !disabled && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg max-h-48 overflow-y-auto">
          {loading ? (
            <div className="px-3 py-2 text-sm text-gray-500 flex items-center gap-2">
              <Loader2 className="size-3 animate-spin" />
              Loading labels...
            </div>
          ) : filteredLabels.length === 0 ? (
            <div className="px-3 py-2 text-sm text-gray-500">
              {filter ? "No labels match" : "No labels available"}
            </div>
          ) : (
            filteredLabels.map(label => {
              const isSelected = selectedLabels.includes(label.name)
              return (
                <button
                  key={label.name}
                  type="button"
                  onClick={() => handleToggleLabel(label.name)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left cursor-pointer hover:bg-gray-50 ${
                    isSelected ? 'bg-blue-50' : ''
                  }`}
                >
                  <span
                    className="size-3 rounded-full shrink-0 border border-gray-200"
                    style={{ backgroundColor: `#${label.color}` }}
                  />
                  <span className="text-gray-700 truncate">{label.name}</span>
                  {isSelected && (
                    <span className="ml-auto text-blue-600 text-xs font-medium shrink-0">Selected</span>
                  )}
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
