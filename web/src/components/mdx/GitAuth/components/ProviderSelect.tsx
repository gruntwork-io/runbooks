import { PROVIDERS, type GitProvider } from "../providers"

interface ProviderSelectProps {
  provider: GitProvider
  /** Called with the chosen provider; the parent runs the full switch sequence. */
  onSelect: (provider: GitProvider) => void
}

const ORDER: readonly GitProvider[] = ['github', 'gitlab'] as const

/**
 * A small segmented control to pick the git provider (GitHub / GitLab),
 * styled like the auth-method tabs. Hidden by the parent when the author sets
 * hideProviderSelect or once authenticated.
 */
export function ProviderSelect({ provider, onSelect }: ProviderSelectProps) {
  return (
    <div
      className="flex gap-1 mb-4 border-b border-border"
      role="tablist"
      aria-label="Git provider"
    >
      {ORDER.map((p) => {
        const cfg = PROVIDERS[p]
        const active = provider === p
        return (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(p)}
            className={`px-4 py-2 text-sm font-medium flex items-center gap-2 transition-colors cursor-pointer ${
              active
                ? 'text-foreground border-b-2 border-primary -mb-px'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <cfg.Logo className="size-4" />
            {cfg.label}
          </button>
        )
      })}
    </div>
  )
}
