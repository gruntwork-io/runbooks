import { KeyRound, RefreshCw } from "lucide-react"
import type { GitLabHostEntry } from "../types"
import { OTHER_INSTANCE_SENTINEL } from "../types"

interface HostSelectProps {
  /** Owning block id, used to derive a unique DOM id for the select. */
  id: string
  /** The merged host union (glab config + env + session + recents). */
  hosts: GitLabHostEntry[]
  /** The currently selected host. */
  value: string
  /** Called with the picked host, or the "__other__" sentinel. */
  onChange: (value: string) => void
  /** Re-read glab's config, refresh trust, and re-run detection. */
  onReload: () => void
  /** Hosts whose credential failed validation this session (key icon downgrade). */
  downgradedHosts?: ReadonlySet<string>
  /** Disable controls while a check is in flight. */
  disabled?: boolean
}

const SOURCE_LABELS: Record<GitLabHostEntry["sources"][number], string> = {
  glab: "glab",
  env: "env",
  session: "session",
  recent: "recent",
}

/**
 * GitLab host picker. Renders whenever there is at
 * least ONE known host (the dropdown is what makes the "Other
 * instance…" row reachable). Entries carry provenance badges and a key icon
 * for the offline has-credential check; a failed validation downgrades the
 * icon for the rest of the session so the dropdown never contradicts the
 * warning chip. The parent hides this entirely for GitHub or when the author
 * pinned a `host`.
 */
export function HostSelect({
  id,
  hosts = [],
  value,
  onChange,
  onReload,
  downgradedHosts,
  disabled,
}: HostSelectProps) {
  const hasChoice = hosts.length >= 1
  // Unique per block so two GitLab GitAuth blocks on one page don't emit
  // duplicate DOM ids (which break label association and are invalid HTML).
  const selectId = `gitlab-host-${id}`

  const selected = hosts.find((h) => h.host === value)
  const selectedDowngraded = downgradedHosts?.has(value) ?? false
  const showCredentialIcon = selected?.hasCredential && !selectedDowngraded

  return (
    <div className="mb-4 flex items-center gap-2 text-sm flex-wrap">
      {hasChoice && (
        <>
          <label htmlFor={selectId} className="text-muted-foreground">
            GitLab host:
          </label>
          <select
            id={selectId}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-foreground disabled:opacity-50"
          >
            {hosts.map((h) => (
              <option key={h.host} value={h.host}>
                {h.host}
              </option>
            ))}
            {/* A never-configured instance is one click away instead of
                buried in the PAT tab. */}
            <option value={OTHER_INSTANCE_SENTINEL}>Other instance…</option>
          </select>

          {/* Provenance badges for the selected host. */}
          {selected && selected.sources.length > 0 && (
            <span className="flex items-center gap-1" data-testid={`host-sources-${id}`}>
              {selected.sources.map((source) => (
                <span
                  key={source}
                  className="text-[10px] uppercase tracking-wide bg-muted text-muted-foreground px-1.5 py-0.5 rounded"
                >
                  {SOURCE_LABELS[source]}
                </span>
              ))}
            </span>
          )}

          {/* Offline credential indicator. The tooltip is deliberate: found,
              not yet validated; downgraded after a failed validation. */}
          {showCredentialIcon && (
            <span
              title="credential found (not yet validated)"
              data-testid={`host-credential-${id}`}
              className="text-muted-foreground"
            >
              <KeyRound className="size-3.5" />
            </span>
          )}
          {selected && selectedDowngraded && (
            <span
              title="credential failed validation this session"
              data-testid={`host-credential-downgraded-${id}`}
              className="text-warning line-through text-xs"
            >
              <KeyRound className="size-3.5" />
            </span>
          )}

          {/* Hosts without a credential get a subtle paste-a-token hint —
              also rendered in the single-host layout, next to Reload. */}
          {selected && !selected.hasCredential && (
            <span className="text-xs text-muted-foreground" data-testid={`host-no-credential-${id}`}>
              no credentials — paste a token
            </span>
          )}
        </>
      )}
      <button
        type="button"
        onClick={onReload}
        disabled={disabled}
        title="Re-read glab config, refresh trust, and re-check credentials"
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 cursor-pointer"
      >
        <RefreshCw className={`size-3.5 ${disabled ? 'animate-spin' : ''}`} />
        Reload
      </button>
    </div>
  )
}
