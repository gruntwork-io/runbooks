import { Search, X } from "lucide-react"

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** Disables the text field (the clear button stays usable). Omit when not needed. */
  disabled?: boolean
}

/**
 * Search box with a leading magnifier and a clear (✕) button that appears once
 * there's a value. Shared by the AwsAuth account/role/profile selectors.
 */
export function SearchInput({ value, onChange, placeholder, disabled }: SearchInputProps) {
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-9 pr-8 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring text-sm"
        disabled={disabled}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}
