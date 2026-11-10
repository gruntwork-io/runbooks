import { FormControl } from "../../_shared/components/FormControls"
import { BoilerplateVariableType } from "@/types/boilerplateVariable"
import type { TofuModuleVariable } from "../../../../../../src/domain/tofu-module/types"
import type { LookupRow } from "../../../../../../src/domain/tofu-module/rowTemplate"
import { OptionCards } from "./OptionCards"
import { PresetPicker } from "./PresetPicker"
import { SuggestInput } from "./SuggestInput"

/** Option cards suit a few choices; more than this get a dropdown. */
const MAX_OPTION_CARDS = 6

interface ModuleFieldProps {
  blockId: string
  variable: TofuModuleVariable
  value: unknown
  error?: string | undefined
  onChange: (value: unknown) => void
  onBlur: () => void
  /** A pick from the input's lookup, whose `sets` fill other inputs. */
  onPick: (row: LookupRow) => void
}

/** A string or number value as a text control shows it; anything else shows as empty. */
const asText = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : ""

const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])

/** One input's control, chosen from its type and what runbooks.yml says about it. */
function Control({ blockId, variable, value, error, onChange, onBlur, onPick }: ModuleFieldProps) {
  const fieldId = `${blockId}-${variable.name}`

  if (variable.presets && variable.presets.length > 0) {
    return (
      <PresetPicker name={fieldId} presets={variable.presets} value={value} onChange={onChange} />
    )
  }

  if (variable.options && (variable.kind === "string" || variable.kind === "list")) {
    const multiple = variable.kind === "list"
    const selected = multiple ? asStrings(value) : asText(value) ? [asText(value)] : []
    if (variable.options.length <= MAX_OPTION_CARDS || multiple) {
      return (
        <OptionCards
          name={fieldId}
          options={variable.options}
          selected={selected}
          multiple={multiple}
          onChange={(next) => onChange(multiple ? next : (next[0] ?? ""))}
        />
      )
    }
    return (
      <select
        id={fieldId}
        value={asText(value)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="min-w-56 rounded-md border border-input bg-card px-3 py-2"
      >
        {variable.hasDefault ? null : <option value="">Choose…</option>}
        {variable.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }

  if (variable.kind === "list") {
    return (
      <SuggestInput
        id={fieldId}
        multiple
        lookup={variable.lookup}
        value={asStrings(value)}
        onChange={onChange}
        onBlur={onBlur}
        onPick={onPick}
        error={error}
        placeholder={
          variable.lookup ? "Type to search, or enter a value" : "Type a value and press Enter"
        }
      />
    )
  }

  if (variable.kind === "string" && variable.lookup) {
    return (
      <SuggestInput
        id={fieldId}
        lookup={variable.lookup}
        value={asText(value)}
        onChange={onChange}
        onBlur={onBlur}
        onPick={onPick}
        error={error}
        placeholder="Type to search"
      />
    )
  }

  if (variable.kind === "json") {
    return (
      <textarea
        id={fieldId}
        value={asText(value)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        rows={4}
        spellCheck={false}
        placeholder={variable.tfType}
        className={`w-full rounded-md border bg-card px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring ${
          error ? "border-destructive" : "border-input"
        }`}
      />
    )
  }

  const type =
    variable.kind === "number"
      ? BoilerplateVariableType.Float
      : variable.kind === "bool"
        ? BoilerplateVariableType.Bool
        : variable.kind === "map"
          ? BoilerplateVariableType.Map
          : BoilerplateVariableType.String
  return (
    <FormControl
      id={blockId}
      variable={{
        name: variable.name,
        description: variable.description,
        type,
        ...(variable.sensitive ? { sensitive: true } : {}),
      }}
      value={value}
      error={error}
      onChange={onChange}
      onBlur={onBlur}
    />
  )
}

/** An input's label, description, control, and what's wrong with it. */
export function ModuleField(props: ModuleFieldProps) {
  const { variable, error, blockId } = props
  const fieldId = `${blockId}-${variable.name}`
  return (
    <div className="space-y-1.5" data-field={variable.name}>
      <label htmlFor={fieldId} className="block text-sm font-medium text-foreground">
        {variable.label}
        {!variable.hasDefault && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {variable.description && (
        <p className="text-sm text-muted-foreground">{variable.description}</p>
      )}
      <Control {...props} />
      {variable.constraints?.map((rule) => (
        <p key={rule} className="text-xs text-muted-foreground">
          Rule: {rule}
        </p>
      ))}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
