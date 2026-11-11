import type { TfModuleOption } from "../../../../../../src/domain/tf-module/types"

interface OptionCardsProps {
  name: string
  options: readonly TfModuleOption[]
  /** The chosen values: one for a string input, any number for a list. */
  selected: readonly string[]
  multiple: boolean
  onChange: (selected: string[]) => void
}

/** Choices shown side by side, each with what it means, for a short list of options. */
export function OptionCards({ name, options, selected, multiple, onChange }: OptionCardsProps) {
  const toggle = (value: string) => {
    if (!multiple) return onChange([value])
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : options.map((o) => o.value).filter((v) => v === value || selected.includes(v)),
    )
  }
  return (
    <div role={multiple ? "group" : "radiogroup"} className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => {
        const checked = selected.includes(option.value)
        return (
          <label
            key={option.value}
            className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm transition-colors ${
              checked ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-accent/40"
            }`}
          >
            <input
              type={multiple ? "checkbox" : "radio"}
              name={name}
              value={option.value}
              checked={checked}
              onChange={() => toggle(option.value)}
              className="mt-0.5 size-4 accent-primary"
            />
            <span>
              <span className="block font-medium text-foreground">{option.label}</span>
              {option.description && (
                <span className="mt-0.5 block text-muted-foreground">{option.description}</span>
              )}
            </span>
          </label>
        )
      })}
    </div>
  )
}
