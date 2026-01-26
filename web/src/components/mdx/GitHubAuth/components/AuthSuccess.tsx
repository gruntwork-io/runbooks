import { CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { GitHubUser } from "../types"

interface AuthSuccessProps {
  user: GitHubUser
  prefillSource: 'env' | null
  onReauthenticate?: () => void
}

export function AuthSuccess({ user, prefillSource, onReauthenticate }: AuthSuccessProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        {user.avatarUrl && (
          <img
            src={user.avatarUrl}
            alt={user.login}
            className="size-10 rounded-full border border-gray-200"
          />
        )}
        <div>
          <div className="font-medium text-gray-900">
            {user.name || user.login}
          </div>
          <div className="text-sm text-gray-500">@{user.login}</div>
        </div>
        <CheckCircle2 className="size-5 text-green-600 ml-auto" />
      </div>

      {prefillSource === 'env' && (
        <p className="text-xs text-gray-500">
          Authenticated using <code className="bg-gray-100 px-1 rounded">GITHUB_TOKEN</code> environment variable.
        </p>
      )}

      {onReauthenticate && (
        <Button variant="outline" size="sm" onClick={onReauthenticate}>
          Use different account
        </Button>
      )}
    </div>
  )
}
