import { CheckCircle2, GitBranch, Folder, Hash } from "lucide-react"
import type { CloneResult } from "../types"

interface CloneSuccessProps {
  result: CloneResult
}

export function CloneSuccess({ result }: CloneSuccessProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-green-700">
        <CheckCircle2 className="size-5" />
        <span className="font-medium">Repository cloned successfully</span>
      </div>

      <div className="bg-white border rounded-md p-3 space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <Folder className="size-4 text-gray-400" />
          <span className="text-gray-600">Repository:</span>
          <span className="font-mono">{result.repo}</span>
        </div>
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 text-gray-400" />
          <span className="text-gray-600">Branch:</span>
          <span className="font-mono">{result.branch}</span>
        </div>
        <div className="flex items-center gap-2">
          <Hash className="size-4 text-gray-400" />
          <span className="text-gray-600">Commit:</span>
          <span className="font-mono text-xs">{result.commitSha.substring(0, 7)}</span>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        The repository files are now available in the Git Workspace panel on the right.
      </p>
    </div>
  )
}
