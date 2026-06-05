import { RefreshCw } from "lucide-react"

interface HostSelectProps {
  /** All GitLab hosts the user is logged into via glab. */
  hosts: string[]
  /** The currently selected host. */
  value: string
  /** Called when the user picks a different host. */
  onChange: (host: string) => void
  /** Re-read glab's config and re-run detection. */
  onReload: () => void
  /** Disable controls while a check is in flight. */
  disabled?: boolean
}

/**
 * GitLab host picker. Shows a dropdown only when the user is logged into more
 * than one instance (e.g. gitlab.com and a self-managed host); otherwise it just
 * surfaces a "Reload" control so the user can re-check after a `glab auth login`.
 * The parent hides this entirely for GitHub or when the author pinned a `host`.
 */
export function HostSelect({ hosts = [], value, onChange, onReload, disabled }: HostSelectProps) {
  const hasChoice = hosts.length > 1

  return (
    <div className="mb-4 flex items-center gap-2 text-sm">
      {hasChoice && (
        <>
          <label htmlFor="gitlab-host" className="text-muted-foreground">
            GitLab host:
          </label>
          <select
            id="gitlab-host"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-foreground disabled:opacity-50"
          >
            {hosts.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </>
      )}
      <button
        type="button"
        onClick={onReload}
        disabled={disabled}
        title="Re-read glab config and re-check credentials"
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 cursor-pointer"
      >
        <RefreshCw className={`size-3.5 ${disabled ? 'animate-spin' : ''}`} />
        Reload
      </button>
    </div>
  )
}
