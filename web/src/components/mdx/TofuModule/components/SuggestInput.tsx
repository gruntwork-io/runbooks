import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { Loader2, X } from "lucide-react"
import type { TofuModuleLookup } from "../../../../../../src/domain/tofu-module/types"
import type { LookupRow } from "../../../../../../src/domain/tofu-module/rowTemplate"
import { useLookup } from "../hooks/useLookup"
import { suggestionFor, type Suggestion } from "../lookupRows"

const inputClasses = (error?: string) =>
  `px-3 py-2 border rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-ring ${
    error ? "border-destructive" : "border-input"
  }`

interface CommonProps {
  id: string
  lookup: TofuModuleLookup | undefined
  error?: string | undefined
  placeholder?: string
  onBlur?: () => void
  /** Called with the row a suggestion came from, when the user picks one. */
  onPick?: (row: LookupRow) => void
}

type SuggestInputProps = CommonProps &
  (
    | { multiple?: false; value: string; onChange: (value: string) => void }
    | { multiple: true; value: string[]; onChange: (value: string[]) => void }
  )

/**
 * A text input, or a list of chips, that suggests values from a lookup as the
 * user types. Typed text is kept as it is: a suggestion helps, it doesn't
 * limit what the module can take.
 */
export function SuggestInput(props: SuggestInputProps) {
  const { id, lookup, error, placeholder, onBlur, onPick } = props
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState("")
  const [highlight, setHighlight] = useState(0)

  const query = props.multiple ? draft : props.value
  const { rows, error: lookupError, loading } = useLookup(lookup?.from, query, focused)

  const suggestions = useMemo(() => {
    if (!lookup) return []
    const taken = new Set(props.multiple ? props.value : [])
    const list: Suggestion[] = []
    for (const row of rows) {
      try {
        const suggestion = suggestionFor(lookup, row)
        if (suggestion.value && !taken.has(suggestion.value)) list.push(suggestion)
      } catch {
        // runbooks.yml's templates were checked when the module loaded.
      }
    }
    return list
  }, [lookup, rows, props.multiple, props.value])

  const open = focused && lookup !== undefined && (suggestions.length > 0 || Boolean(lookupError))

  const addChip = (value: string) => {
    if (!props.multiple) return
    const trimmed = value.trim()
    if (trimmed && !props.value.includes(trimmed)) props.onChange([...props.value, trimmed])
    setDraft("")
  }

  const pick = (suggestion: Suggestion) => {
    if (props.multiple) addChip(suggestion.value)
    else props.onChange(suggestion.value)
    onPick?.(suggestion.row)
    setHighlight(0)
    if (!props.multiple) setFocused(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault()
      setHighlight((h) => (h + 1) % suggestions.length)
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault()
      setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length)
    } else if (e.key === "Enter") {
      e.preventDefault()
      const suggestion = open ? suggestions[highlight] : undefined
      if (suggestion) pick(suggestion)
      else if (props.multiple) addChip(draft)
    } else if (e.key === "," && props.multiple) {
      e.preventDefault()
      addChip(draft)
    } else if (e.key === "Backspace" && props.multiple && draft === "" && props.value.length > 0) {
      props.onChange(props.value.slice(0, -1))
    } else if (e.key === "Escape") {
      setFocused(false)
    }
  }

  const input = (
    <input
      ref={inputRef}
      id={id}
      type="text"
      role="combobox"
      aria-expanded={open}
      aria-controls={listId}
      aria-autocomplete="list"
      autoComplete="off"
      placeholder={placeholder}
      value={props.multiple ? draft : props.value}
      onChange={(e) => {
        setHighlight(0)
        if (props.multiple) setDraft(e.target.value)
        else props.onChange(e.target.value)
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        if (props.multiple && draft.trim()) addChip(draft)
        onBlur?.()
      }}
      onKeyDown={onKeyDown}
      className={
        props.multiple
          ? "min-w-40 flex-1 bg-transparent py-1 outline-none"
          : `${inputClasses(error)} w-full pr-8`
      }
    />
  )

  return (
    <div className="relative">
      {props.multiple ? (
        <div
          className={`${inputClasses(error)} flex flex-wrap items-center gap-1.5 py-1.5 cursor-text`}
          onClick={() => inputRef.current?.focus()}
        >
          {props.value.map((item) => (
            <span
              key={item}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-0.5 text-sm"
            >
              {item}
              <button
                type="button"
                aria-label={`Remove ${item}`}
                className="text-muted-foreground hover:text-foreground"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.onChange(props.value.filter((v) => v !== item))}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {input}
        </div>
      ) : (
        input
      )}
      {loading && focused && lookup && (
        <Loader2 className="absolute right-2.5 top-3 size-4 animate-spin text-muted-foreground" />
      )}
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover py-1 shadow-lg"
        >
          {lookupError ? (
            <li className="px-3 py-2 text-sm text-destructive">{lookupError}</li>
          ) : (
            suggestions.map((suggestion, index) => (
              <li
                key={suggestion.value}
                role="option"
                aria-selected={index === highlight}
                className={`cursor-pointer px-3 py-2 text-sm ${index === highlight ? "bg-accent text-accent-foreground" : ""}`}
                onMouseEnter={() => setHighlight(index)}
                // Before the input's blur, which would close the list first.
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(suggestion)
                }}
              >
                <div className="font-medium">{suggestion.label}</div>
                {suggestion.label !== suggestion.value && (
                  <div className="text-xs text-muted-foreground">{suggestion.value}</div>
                )}
                {suggestion.detail && (
                  <div className="text-xs text-muted-foreground">{suggestion.detail}</div>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
