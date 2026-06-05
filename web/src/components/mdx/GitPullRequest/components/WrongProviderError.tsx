import { AlertTriangle } from "lucide-react"
import type { GitProvider } from "@/components/mdx/GitAuth/types"
import { PR_PROVIDERS, type PRProviderConfig } from "../providers"

interface WrongProviderErrorProps {
  /** This block's (locked/derived) provider config. */
  cfg: PRProviderConfig
  /** The provider the linked auth block actually resolved to. */
  authDerivedProvider: GitProvider
}

/**
 * Blocking error shown when a provider-locked PR/MR block is wired to an auth
 * block for the other provider (e.g. a GitLab Merge Request block linked to a
 * GitHub auth block). Rendered identically in interactive and instruction mode.
 */
export function WrongProviderError({ cfg, authDerivedProvider }: WrongProviderErrorProps) {
  const linked = PR_PROVIDERS[authDerivedProvider]
  const matchingAuthBlock = cfg.id === 'github' ? 'GitHubAuth' : 'GitLabAuth'

  return (
    <div className="mb-4 p-3 bg-destructive-muted border border-destructive/30 rounded-md flex items-start gap-2">
      <AlertTriangle className="size-4 text-destructive mt-0.5 shrink-0" />
      <div>
        <p className="text-sm font-medium text-destructive m-0">Wrong authentication provider</p>
        <p className="text-xs text-destructive m-0 mt-0.5">
          This {cfg.noun.singular} block is linked to a {linked.label} authentication block, but it
          can only be used with a {cfg.label} auth block. Link a{' '}
          <code className="bg-destructive-muted px-1 rounded">{`<${matchingAuthBlock}>`}</code>{' '}
          (or <code className="bg-destructive-muted px-1 rounded">{`<GitAuth provider="${cfg.id}">`}</code>)
          block, or use the generic{' '}
          <code className="bg-destructive-muted px-1 rounded">{`<GitPullRequest>`}</code> block to
          support either provider.
        </p>
      </div>
    </div>
  )
}
