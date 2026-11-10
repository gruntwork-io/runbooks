import { Info } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { TfModulePreset } from "../../../../../../src/domain/tf-module/types"

interface PresetPickerProps {
  name: string
  presets: readonly TfModulePreset[]
  /** The input's value: the settings of the preset it was set from, or anything else. */
  value: unknown
  onChange: (settings: Record<string, unknown>) => void
}

const settingText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value))

/** Which preset a value came from: the one whose settings it equals. */
export function presetOf(
  presets: readonly TfModulePreset[],
  value: unknown,
): TfModulePreset | undefined {
  const text = JSON.stringify(value)
  return presets.find((preset) => JSON.stringify(preset.settings) === text)
}

/**
 * Named sets of settings for an object or map input. The info icon beside
 * each lists every setting the preset makes, so nobody picks one blind.
 */
export function PresetPicker({ name, presets, value, onChange }: PresetPickerProps) {
  const chosen = presetOf(presets, value)
  return (
    <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
      {presets.map((preset) => {
        const checked = chosen?.name === preset.name
        return (
          <div
            key={preset.name}
            className={`flex gap-3 rounded-md border p-3 text-sm ${
              checked ? "border-primary bg-primary/5" : "border-border bg-card"
            }`}
          >
            <label className="flex flex-1 cursor-pointer gap-3">
              <input
                type="radio"
                name={name}
                value={preset.name}
                checked={checked}
                onChange={() => onChange({ ...preset.settings })}
                className="mt-0.5 size-4 accent-primary"
              />
              <span>
                <span className="block font-medium text-foreground">{preset.label}</span>
                {preset.description && (
                  <span className="mt-0.5 block text-muted-foreground">{preset.description}</span>
                )}
              </span>
            </label>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={`What ${preset.label} sets`}
                  className="self-start rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <Info className="size-4" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-96 max-w-[90vw]" align="end">
                <p className="mb-2 text-sm font-semibold">{preset.label} sets</p>
                <table className="w-full text-xs">
                  <tbody>
                    {Object.entries(preset.settings).map(([key, setting]) => (
                      <tr key={key} className="border-t border-border first:border-t-0">
                        <td className="py-1.5 pr-3 font-mono text-muted-foreground">{key}</td>
                        <td className="py-1.5 font-mono">{settingText(setting)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </PopoverContent>
            </Popover>
          </div>
        )
      })}
    </div>
  )
}
