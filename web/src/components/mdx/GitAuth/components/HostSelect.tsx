import { KeyRound, RefreshCw } from "lucide-react"
import type { GitHostEntry } from "../types"
import { OTHER_INSTANCE_SENTINEL } from "../types"
import type { ProviderConfig } from "../providers"

interface HostSelectProps {
  /** Owning block id, used to derive a unique DOM id for the select. */
  id: string
  /** The provider whose hosts are listed (label, CLI name, "Other instance…"). */
  provider: ProviderConfig
  /** The merged host union (gh/glab config + env + session + recents). */
  hosts: GitHostEntry[]
  /** The currently selected host. */
  value: string
  /** Called with the picked host, or the "__other__" sentinel. */
  onChange: (value: string) => void
  /** Re-read the CLI's config, refresh trust, and re-run detection. */
  onReload: () => void
  /** Hosts whose credential failed validation this session (key icon downgrade). */
  downgradedHosts?: ReadonlySet<string>
  /** Disable controls while a check is in flight. */
  disabled?: boolean
  /**
   * Whether the block auto-detects credentials (default true). When false
   * (`detectCredentials={false}`) the picker is a plain host list: no
   * provenance badges, key icons or "no credentials" hint, which all describe
   * what detection would find, and no Reload, which re-runs detection.
   */
  detectsCredentials?: boolean
}

const SOURCE_LABELS: Record<GitHostEntry["sources"][number], string> = {
  gh: "gh",
  glab: "glab",
  env: "env",
  session: "session",
  recent: "recent",
}

/**
 * GitLab / GitHub host picker. For GitLab it renders whenever there is at
 * least ONE known host (the dropdown is what makes the "Other
 * instance…" row reachable); the parent shows it for GitHub only when there is
 * more than one host. Entries carry provenance badges and a key icon
 * for the offline has-credential check; a failed validation downgrades the
 * icon for the rest of the session so the dropdown never contradicts the
 * warning chip. The parent hides this entirely when the author pinned a `host`.
 * With detection disabled only the host list itself remains.
 */
export function HostSelect({
  id,
  provider,
  hosts = [],
  value,
  onChange,
  onReload,
  downgradedHosts,
  disabled,
  detectsCredentials = true,
}: HostSelectProps) {
  const hasChoice = hosts.length >= 1
  // Nothing to show: no hosts to pick, and Reload is a detection control.
  if (!hasChoice && !detectsCredentials) return null

  // Unique per block so two GitAuth blocks on one page don't emit
  // duplicate DOM ids (which break label association and are invalid HTML).
  const selectId = `${provider.id}-host-${id}`

  const selected = hosts.find((h) => h.host === value)
  // The badges, key icons and no-credential hint all describe what detection
  // would find, so without detection the selected host goes unannotated.
  const annotated = detectsCredentials ? selected : undefined
  const selectedDowngraded = downgradedHosts?.has(value) ?? false
  const showCredentialIcon = annotated?.hasCredential && !selectedDowngraded

  return (
    <div className="mb-4 flex items-center gap-2 text-sm flex-wrap">
      {hasChoice && (
        <>
          <label htmlFor={selectId} className="text-muted-foreground">
            {provider.label} host:
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
            {/* An entered (or prop-seeded) instance URL can target a host the
                union doesn't list. Show it, or the select would display the
                first host while detection targets another — and picking that
                host would fire no change. */}
            {!selected && value && <option value={value}>{value}</option>}
            {/* A never-configured instance is one click away (GitLab only):
                this leaves the success card if needed and focuses the PAT
                form's instance-URL field. */}
            {provider.supportsManualInstance && (
              <option value={OTHER_INSTANCE_SENTINEL}>Other instance…</option>
            )}
          </select>

          {/* Provenance badges for the selected host. */}
          {annotated && annotated.sources.length > 0 && (
            <span className="flex items-center gap-1" data-testid={`host-sources-${id}`}>
              {annotated.sources.map((source) => (
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
          {annotated && selectedDowngraded && (
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
          {annotated && !annotated.hasCredential && (
            <span
              className="text-xs text-muted-foreground"
              data-testid={`host-no-credential-${id}`}
            >
              no credentials — paste a token
            </span>
          )}
        </>
      )}
      {detectsCredentials && (
        <button
          type="button"
          onClick={onReload}
          disabled={disabled}
          title={`Re-read ${provider.cli.binary} config, refresh trust, and re-check credentials`}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`size-3.5 ${disabled ? "animate-spin" : ""}`} />
          Reload
        </button>
      )}
    </div>
  )
}
