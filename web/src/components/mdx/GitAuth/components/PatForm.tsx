import { Eye, EyeOff, Loader2, HelpCircle, ChevronDown, ChevronUp, ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useState } from "react"
import type { GitAuthStatus } from "../types"
import type { ProviderConfig } from "../providers"

interface PatFormProps {
  authStatus: GitAuthStatus
  patToken: string
  setPatToken: (value: string) => void
  showPatToken: boolean
  setShowPatToken: (value: boolean) => void
  onSubmit: () => void
  provider: ProviderConfig
}

export function PatForm({
  authStatus,
  patToken,
  setPatToken,
  showPatToken,
  setShowPatToken,
  onSubmit,
  provider,
}: PatFormProps) {
  const isAuthenticating = authStatus === 'authenticating'
  const [showSetupGuide, setShowSetupGuide] = useState(false)

  return (
    <div className="space-y-4">
      <div className="bg-info-muted/50 rounded p-3 text-sm text-foreground">
        <p>
          Enter a {provider.label} Personal Access Token.
        </p>
      </div>

      {/* Token input */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">
          Personal Access Token
        </label>
        <div className="relative">
          <input
            type={showPatToken ? 'text' : 'password'}
            value={patToken}
            onChange={(e) => setPatToken(e.target.value)}
            className="w-full px-3 py-2 pr-10 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm"
            placeholder={provider.pat.placeholder}
            disabled={isAuthenticating}
          />
          <button
            type="button"
            onClick={() => setShowPatToken(!showPatToken)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {showPatToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        {provider.pat.prefixHint && (
          <p className="mt-1 text-xs text-muted-foreground">
            {provider.pat.prefixHint}
          </p>
        )}
      </div>

      <Button
        onClick={onSubmit}
        disabled={isAuthenticating || !patToken}
        className="bg-info hover:bg-info/90 text-white"
      >
        {isAuthenticating ? (
          <>
            <Loader2 className="size-4 animate-spin mr-2" />
            Authenticating...
          </>
        ) : (
          'Authenticate'
        )}
      </Button>

      {/* Setup guide */}
      <div className="text-xs">
        <button
          type="button"
          onClick={() => setShowSetupGuide(!showSetupGuide)}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <HelpCircle className="size-3" />
          <span>How do I create a token?</span>
          {showSetupGuide ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </button>

        {showSetupGuide && (
          <div className="mt-2 p-3 bg-muted rounded border border-border text-muted-foreground space-y-3">
            {provider.pat.setupGuide === 'gitlab' ? (
              <>
                <div>
                  <p className="font-medium text-foreground">1. Create a personal access token:</p>
                  <a
                    href={provider.pat.tokenCreateUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-info hover:underline break-all"
                  >
                    <ExternalLink className="size-3 flex-shrink-0" />
                    {provider.pat.tokenCreateUrl.replace(/^https?:\/\//, '')}
                  </a>
                </div>

                <div>
                  <p className="font-medium text-foreground">2. Select scopes:</p>
                  <p>
                    Choose <code className="bg-accent px-1 rounded">api</code> for full access, or{' '}
                    <code className="bg-accent px-1 rounded">read_repository</code> +{' '}
                    <code className="bg-accent px-1 rounded">write_repository</code> for clone/push only.
                  </p>
                </div>

                <div>
                  <p className="font-medium text-foreground">3. Create and copy the token</p>
                  <p>
                    Paste it above. GitLab personal access tokens start with{' '}
                    <code className="bg-accent px-1 rounded">glpat-</code>.
                  </p>
                </div>
              </>
            ) : (
              <>
                <div>
                  <p className="font-medium text-foreground">1. Create a fine-grained token:</p>
                  <a
                    href={provider.pat.tokenCreateUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-info hover:underline"
                  >
                    <ExternalLink className="size-3" />
                    {provider.pat.tokenCreateUrl.replace(/^https?:\/\//, '')}
                  </a>
                </div>

                <div>
                  <p className="font-medium text-foreground">2. Set repository access:</p>
                  <p>Select "Only select repositories" and choose the repos you need, or "All repositories" for broader access.</p>
                </div>

                <div>
                  <p className="font-medium text-foreground">3. Grant these permissions:</p>
                  <ul className="ml-4 list-disc">
                    <li><strong>Contents</strong>: Read and write (for clone/push)</li>
                    <li><strong>Pull requests</strong>: Read and write (for creating PRs)</li>
                    <li><strong>Metadata</strong>: Read-only (required, usually auto-selected)</li>
                  </ul>
                </div>

                <div>
                  <p className="font-medium text-foreground">4. Generate and copy the token</p>
                  <p>Paste it above. Fine-grained tokens start with <code className="bg-accent px-1 rounded">github_pat_</code></p>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
