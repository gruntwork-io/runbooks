import { GitBranch, MessageSquare, FileText, Loader2, GitPullRequest } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import type { PRStatus } from "../types"

interface PRFormProps {
  status: PRStatus
  branchName: string
  setBranchName: (value: string) => void
  commitMessage: string
  setCommitMessage: (value: string) => void
  prTitle: string
  setPrTitle: (value: string) => void
  prBody: string
  setPrBody: (value: string) => void
  isDraft: boolean
  setIsDraft: (value: boolean) => void
  onSubmit: () => void
  progressMessage: string
  changedFilesCount: number
}

export function PRForm({
  status,
  branchName,
  setBranchName,
  commitMessage,
  setCommitMessage,
  prTitle,
  setPrTitle,
  prBody,
  setPrBody,
  isDraft,
  setIsDraft,
  onSubmit,
  progressMessage,
  changedFilesCount,
}: PRFormProps) {
  const isCreating = status === 'creating'
  const canSubmit = branchName.trim() && commitMessage.trim() && prTitle.trim() && changedFilesCount > 0

  return (
    <div className="space-y-4">
      {/* Branch name */}
      <div className="space-y-2">
        <Label htmlFor="branch-name" className="flex items-center gap-2">
          <GitBranch className="size-4" />
          Branch Name
        </Label>
        <Input
          id="branch-name"
          value={branchName}
          onChange={(e) => setBranchName(e.target.value)}
          placeholder="feature/my-changes"
          disabled={isCreating}
          className="font-mono"
        />
      </div>

      {/* Commit message */}
      <div className="space-y-2">
        <Label htmlFor="commit-message" className="flex items-center gap-2">
          <MessageSquare className="size-4" />
          Commit Message
        </Label>
        <Input
          id="commit-message"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Add new configuration"
          disabled={isCreating}
        />
      </div>

      {/* PR title */}
      <div className="space-y-2">
        <Label htmlFor="pr-title" className="flex items-center gap-2">
          <FileText className="size-4" />
          Pull Request Title
        </Label>
        <Input
          id="pr-title"
          value={prTitle}
          onChange={(e) => setPrTitle(e.target.value)}
          placeholder="[Runbook] Add new configuration"
          disabled={isCreating}
        />
      </div>

      {/* PR body */}
      <div className="space-y-2">
        <Label htmlFor="pr-body">Pull Request Description (optional)</Label>
        <textarea
          id="pr-body"
          value={prBody}
          onChange={(e) => setPrBody(e.target.value)}
          placeholder="Describe the changes..."
          disabled={isCreating}
          className="w-full h-24 px-3 py-2 text-sm border rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Draft checkbox */}
      <div className="flex items-center gap-2">
        <Checkbox
          id="draft"
          checked={isDraft}
          onCheckedChange={(checked) => setIsDraft(checked === true)}
          disabled={isCreating}
        />
        <Label htmlFor="draft" className="text-sm font-normal cursor-pointer">
          Create as draft pull request
        </Label>
      </div>

      {/* Submit button */}
      <Button
        onClick={onSubmit}
        disabled={isCreating || !canSubmit}
        className="w-full"
        size="lg"
      >
        {isCreating ? (
          <>
            <Loader2 className="size-4 mr-2 animate-spin" />
            {progressMessage || 'Creating...'}
          </>
        ) : (
          <>
            <GitPullRequest className="size-4 mr-2" />
            Create Pull Request
            {changedFilesCount > 0 && (
              <span className="ml-2 px-2 py-0.5 bg-white/20 rounded text-xs">
                {changedFilesCount} file{changedFilesCount !== 1 ? 's' : ''}
              </span>
            )}
          </>
        )}
      </Button>
    </div>
  )
}
