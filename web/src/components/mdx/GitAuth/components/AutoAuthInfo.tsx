import { useState } from "react"
import { HelpCircle, ChevronDown, ChevronUp } from "lucide-react"
import type { ProviderConfig } from "../providers"

interface AutoAuthInfoProps {
  provider: ProviderConfig
}

/**
 * Collapsible "How can I authenticate automatically?" FAQ. Extracted from the
 * GitHub OAuth flow so it can also render under the GitLab PAT form, where
 * there is no OAuth tab. Explains the CLI and env-var auto-detection paths
 * using the active provider's CLI command and token env var.
 */
export function AutoAuthInfo({ provider }: AutoAuthInfoProps) {
  const [show, setShow] = useState(false)

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <HelpCircle className="size-3" />
        <span>How can I authenticate to {provider.label} automatically?</span>
        {show ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      </button>

      {show && (
        <div className="mt-2 p-3 bg-muted rounded border border-border text-muted-foreground space-y-2">
          <p>
            Runbooks can automatically detect your {provider.label} credentials so you don't have to sign in manually each time.
          </p>
          <p>
            <strong>Option 1: {provider.cli.label}</strong> — Run{' '}
            <code className="bg-accent px-1 rounded text-xs">{provider.cli.loginCmd}</code> in your terminal.
          </p>
          <p>
            <strong>Option 2: Environment variable</strong> — Set{' '}
            <code className="bg-accent px-1 rounded text-xs">{provider.env.tokenVar}</code> to your {provider.label} access token.
          </p>
          <p className="text-muted-foreground">
            After setting up either option, reload the runbook and Runbooks will detect your credentials automatically.
          </p>
        </div>
      )}
    </div>
  )
}
