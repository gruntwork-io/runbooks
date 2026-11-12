import { AlertTriangle, ChevronRight, Copy, Loader2, LogIn } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { formatGcloudAdcLoginCommand } from "../constants"

const GOOGLE_SCOPE_PREFIX = "https://www.googleapis.com/auth/"

/** A scope as people read it: `cloud-identity.groups` rather than its full URL. */
function scopeName(scope: string): string {
  return scope.startsWith(GOOGLE_SCOPE_PREFIX) ? scope.slice(GOOGLE_SCOPE_PREFIX.length) : scope
}

/** The scopes the credentials lack, folded away until asked for. */
export function MissingScopesDetails({ missing }: { missing: readonly string[] }) {
  return (
    <details className="group text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
        {missing.length === 1
          ? "Show the missing scope"
          : `Show the ${missing.length} missing scopes`}
      </summary>
      <ul className="mt-2 ml-5 space-y-0.5">
        {missing.map((scope) => (
          <li key={scope}>
            <code className="rounded bg-accent px-1 text-xs" title={scope}>
              {scopeName(scope)}
            </code>
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * The gcloud command that signs in with every scope the block requires,
 * through the OAuth client in $GOOGLE_OAUTH_CLIENT_CREDENTIALS.
 */
export function ScopesCommand({ requiredScopes }: { requiredScopes: readonly string[] }) {
  const [copied, setCopied] = useState(false)
  const command = formatGcloudAdcLoginCommand(requiredScopes)

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may be denied; the command is still selectable in the UI.
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Or run this command as the same user, with <code>GOOGLE_OAUTH_CLIENT_CREDENTIALS</code> set
        to your OAuth client's JSON file. Google can refuse gcloud's own client these scopes, which
        shows as "This app is blocked".
      </p>
      <div className="flex items-start gap-2">
        <code className="max-h-24 flex-1 overflow-y-auto rounded border border-warning/30 bg-card px-2 py-1.5 font-mono text-xs break-all">
          {command}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={() => void copyCommand()}>
          <Copy className="mr-1 size-3.5" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  )
}

interface MissingScopesNoticeProps {
  principal?: string | undefined
  missing: readonly string[]
  requiredScopes: readonly string[]
  oauthUnavailable: boolean
  signingIn?: boolean
  onSignIn: () => void
}

/**
 * A sign-in whose credentials validated but lack scopes the block requires:
 * who signed in, how many scopes are missing, and how to sign in with them.
 */
export function MissingScopesNotice({
  principal,
  missing,
  requiredScopes,
  oauthUnavailable,
  signingIn = false,
  onSignIn,
}: MissingScopesNoticeProps) {
  const count = missing.length === 1 ? "a scope" : `${missing.length} scopes`
  return (
    <div className="mb-4 space-y-3 rounded-lg border border-warning/40 bg-warning-muted p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 flex-shrink-0 text-warning" />
        <div>
          <div className="font-semibold text-foreground">
            Missing permissions this runbook needs
          </div>
          <div className="text-sm text-muted-foreground">
            {principal ? (
              <>
                <span className="font-medium text-foreground">{principal}</span> signed in, but
                without {count} this runbook asks for.
              </>
            ) : (
              <>These credentials are missing {count} this runbook asks for.</>
            )}
          </div>
        </div>
      </div>
      <MissingScopesDetails missing={missing} />
      {oauthUnavailable ? (
        <>
          <p className="text-sm text-muted-foreground">
            Google Sign-In asks for every scope at once, but it needs an OAuth client: start
            Runbooks with <code>GOOGLE_OAUTH_CLIENT_CREDENTIALS</code> set to your OAuth client's
            JSON file.
          </p>
          <ScopesCommand requiredScopes={requiredScopes} />
        </>
      ) : (
        <Button
          onClick={onSignIn}
          disabled={signingIn}
          size="sm"
          className="bg-info text-info-foreground hover:bg-info/90"
        >
          {signingIn ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <LogIn className="mr-2 size-4" />
          )}
          {signingIn ? "Starting sign-in…" : "Sign in with Google"}
        </Button>
      )}
    </div>
  )
}
