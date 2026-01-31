import { Eye, EyeOff, Loader2, HelpCircle, ChevronDown, ChevronUp, ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useState } from "react"
import type { GitHubAuthStatus } from "../types"

interface PatFormProps {
  authStatus: GitHubAuthStatus
  patToken: string
  setPatToken: (value: string) => void
  showPatToken: boolean
  setShowPatToken: (value: boolean) => void
  onSubmit: () => void
}

export function PatForm({
  authStatus,
  patToken,
  setPatToken,
  showPatToken,
  setShowPatToken,
  onSubmit,
}: PatFormProps) {
  const isAuthenticating = authStatus === 'authenticating'
  const [showSetupGuide, setShowSetupGuide] = useState(false)

  return (
    <div className="space-y-4">
      <div className="bg-violet-100/50 rounded p-3 text-sm text-gray-700">
        <p>
          Enter a GitHub Personal Access Token.
        </p>
      </div>

      {/* Token input */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Personal Access Token
        </label>
        <div className="relative">
          <input
            type={showPatToken ? 'text' : 'password'}
            value={patToken}
            onChange={(e) => setPatToken(e.target.value)}
            className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500 font-mono text-sm"
            placeholder="github_pat_... or ghp_..."
            disabled={isAuthenticating}
          />
          <button
            type="button"
            onClick={() => setShowPatToken(!showPatToken)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            {showPatToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          Fine-grained tokens start with <code className="bg-gray-100 px-1 rounded">github_pat_</code>, 
          classic tokens with <code className="bg-gray-100 px-1 rounded">ghp_</code>
        </p>
      </div>

      <Button
        onClick={onSubmit}
        disabled={isAuthenticating || !patToken}
        className="bg-violet-600 hover:bg-violet-700 text-white"
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
          className="flex items-center gap-1 text-gray-500 hover:text-gray-700 cursor-pointer"
        >
          <HelpCircle className="size-3" />
          <span>How do I create a token?</span>
          {showSetupGuide ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </button>
        
        {showSetupGuide && (
          <div className="mt-2 p-3 bg-gray-50 rounded border border-gray-200 text-gray-600 space-y-3">
            <div>
              <p className="font-medium text-gray-700">1. Create a fine-grained token:</p>
              <a
                href="https://github.com/settings/personal-access-tokens/new"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-violet-600 hover:underline"
              >
                <ExternalLink className="size-3" />
                github.com/settings/personal-access-tokens/new
              </a>
            </div>
            
            <div>
              <p className="font-medium text-gray-700">2. Set repository access:</p>
              <p>Select "Only select repositories" and choose the repos you need, or "All repositories" for broader access.</p>
            </div>
            
            <div>
              <p className="font-medium text-gray-700">3. Grant these permissions:</p>
              <ul className="ml-4 list-disc">
                <li><strong>Contents</strong>: Read and write (for clone/push)</li>
                <li><strong>Pull requests</strong>: Read and write (for creating PRs)</li>
                <li><strong>Metadata</strong>: Read-only (required, usually auto-selected)</li>
              </ul>
            </div>
            
            <div>
              <p className="font-medium text-gray-700">4. Generate and copy the token</p>
              <p>Paste it above. Fine-grained tokens start with <code className="bg-gray-200 px-1 rounded">github_pat_</code></p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
