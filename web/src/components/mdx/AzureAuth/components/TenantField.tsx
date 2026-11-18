interface TenantFieldProps {
  value: string
  onChange: (value: string) => void
  /** The block's `tenantId` prop: shown, and not editable. */
  pinned?: string | undefined
  disabled?: boolean
  required?: boolean
  hint?: string
}

const INPUT_CLASSES =
  "w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm placeholder-muted-foreground disabled:opacity-60"

export function TenantField({
  value,
  onChange,
  pinned,
  disabled,
  required,
  hint,
}: TenantFieldProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1">
        Tenant ID{required ? <span className="text-destructive"> *</span> : " (optional)"}
      </label>
      <input
        type="text"
        aria-label="Tenant ID"
        value={pinned ?? value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="00000000-0000-0000-0000-000000000000 or contoso.onmicrosoft.com"
        className={INPUT_CLASSES}
        disabled={disabled || pinned !== undefined}
      />
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  )
}

export { INPUT_CLASSES }
