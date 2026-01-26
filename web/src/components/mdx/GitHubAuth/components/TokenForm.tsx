import { Eye, EyeOff, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { GitHubAuthStatus } from "../types"

interface TokenFormProps {
  authStatus: GitHubAuthStatus
  token: string
  setToken: (token: string) => void
  showToken: boolean
  setShowToken: (show: boolean) => void
  onSubmit: () => void
}

export function TokenForm({
  authStatus,
  token,
  setToken,
  showToken,
  setShowToken,
  onSubmit,
}: TokenFormProps) {
  const isAuthenticating = authStatus === 'authenticating'

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="github-token">Personal Access Token</Label>
        <div className="relative">
          <Input
            id="github-token"
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            className="pr-10 font-mono text-sm"
            disabled={isAuthenticating}
            onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          />
          <button
            type="button"
            onClick={() => setShowToken(!showToken)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            disabled={isAuthenticating}
          >
            {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Create a token at{" "}
          <a
            href="https://github.com/settings/tokens"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            GitHub Settings → Developer settings → Personal access tokens
          </a>
          . The token needs <code className="bg-gray-100 px-1 rounded">repo</code> scope.
        </p>
      </div>

      <Button
        onClick={onSubmit}
        disabled={isAuthenticating || !token.trim()}
        className="w-full"
      >
        {isAuthenticating ? (
          <>
            <Loader2 className="size-4 mr-2 animate-spin" />
            Authenticating...
          </>
        ) : (
          "Authenticate"
        )}
      </Button>
    </div>
  )
}
