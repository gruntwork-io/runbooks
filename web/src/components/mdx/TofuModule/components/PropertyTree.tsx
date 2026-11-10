import { isHiddenValue, type PropertyValue } from "../../../../../../src/domain/tofu-module/run"

/** Whether a value has nothing to show: null, empty text, or an empty list or map. */
function isEmpty(value: PropertyValue): boolean {
  if (value === null || value === "") return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === "object" && !isHiddenValue(value)) return Object.keys(value).length === 0
  return false
}

function Scalar({ value }: { value: PropertyValue }) {
  if (isHiddenValue(value)) {
    return <span className="italic text-muted-foreground">({value.hidden})</span>
  }
  if (typeof value === "string") return <span className="break-all text-foreground">"{value}"</span>
  return <span className="text-foreground">{JSON.stringify(value)}</span>
}

function Value({ value }: { value: PropertyValue }) {
  if (value === null || typeof value !== "object" || isHiddenValue(value)) {
    return <Scalar value={value} />
  }
  const entries = Array.isArray(value)
    ? value.map((item, i) => [String(i), item] as const)
    : Object.entries(value as Record<string, PropertyValue>)
  if (entries.length === 0)
    return <span className="text-muted-foreground">{Array.isArray(value) ? "[]" : "{}"}</span>
  return (
    <dl className="mt-0.5 space-y-0.5 border-l border-border pl-3">
      {entries.map(([key, item]) => (
        <Row key={key} name={Array.isArray(value) ? `[${key}]` : key} value={item} />
      ))}
    </dl>
  )
}

function Row({ name, value }: { name: string; value: PropertyValue }) {
  const nested =
    value !== null && typeof value === "object" && !isHiddenValue(value) && !isEmpty(value)
  return (
    <div className={nested ? "" : "flex gap-2"}>
      <dt className="shrink-0 text-muted-foreground">{name}</dt>
      <dd className="min-w-0">
        <Value value={value} />
      </dd>
    </div>
  )
}

/**
 * A resource's properties, nested as OpenTofu holds them. Empty values are
 * left out, since most of a resource's attributes are unset.
 */
export function PropertyTree({
  properties,
}: {
  properties: Readonly<Record<string, PropertyValue>>
}) {
  const shown = Object.entries(properties).filter(([, value]) => !isEmpty(value))
  if (shown.length === 0) {
    return <p className="font-mono text-xs text-muted-foreground">No properties.</p>
  }
  return (
    <dl className="space-y-0.5 font-mono text-xs">
      {shown.map(([name, value]) => (
        <Row key={name} name={name} value={value} />
      ))}
    </dl>
  )
}
