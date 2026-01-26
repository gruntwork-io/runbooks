import { CheckCircle2, ExternalLink, GitBranch, Hash, GitPullRequest } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { PRResult } from "../types"

interface PRSuccessProps {
  result: PRResult
}

export function PRSuccess({ result }: PRSuccessProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-green-700">
        <CheckCircle2 className="size-5" />
        <span className="font-medium">Pull request created successfully!</span>
      </div>

      <div className="bg-white border rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-3">
          <GitPullRequest className="size-5 text-purple-600" />
          <div>
            <a
              href={result.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline font-medium flex items-center gap-1"
            >
              PR #{result.prNumber}
              <ExternalLink className="size-3" />
            </a>
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm text-gray-600">
          <GitBranch className="size-4 text-gray-400" />
          <span>Branch:</span>
          <span className="font-mono">{result.branchName}</span>
        </div>

        <div className="flex items-center gap-2 text-sm text-gray-600">
          <Hash className="size-4 text-gray-400" />
          <span>Commit:</span>
          <span className="font-mono">{result.commitSha.substring(0, 7)}</span>
        </div>
      </div>

      <Button
        variant="outline"
        className="w-full"
        onClick={() => window.open(result.prUrl, '_blank')}
      >
        <ExternalLink className="size-4 mr-2" />
        View Pull Request on GitHub
      </Button>
    </div>
  )
}
