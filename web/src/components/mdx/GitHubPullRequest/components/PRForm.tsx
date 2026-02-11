import { useState } from "react"
import { Loader2, ChevronDown, ChevronRight, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MarkdownEditor } from "./MarkdownEditor"
import { LabelSelector } from "./LabelSelector"
import type { GitHubLabel, PRBlockStatus } from "../types"

interface PRFormProps {
  prTitle: string
  setPRTitle: (v: string) => void
  prDescription: string
  setPRDescription: (v: string) => void
  branchName: string
  setBranchName: (v: string) => void
  commitMessage: string
  setCommitMessage: (v: string) => void
  selectedLabels: string[]
  setSelectedLabels: (labels: string[]) => void
  availableLabels: GitHubLabel[]
  labelsLoading: boolean
  status: PRBlockStatus
  disabled: boolean
  onSubmit: () => void
  onCancel: () => void
}

export function PRForm({
  prTitle,
  setPRTitle,
  prDescription,
  setPRDescription,
  branchName,
  setBranchName,
  commitMessage,
  setCommitMessage,
  selectedLabels,
  setSelectedLabels,
  availableLabels,
  labelsLoading,
  status,
  disabled,
  onSubmit,
  onCancel,
}: PRFormProps) {
  const [commitMessageExpanded, setCommitMessageExpanded] = useState(commitMessage !== "Changes from runbook")

  const isCreating = status === 'creating'
  const isFormDisabled = disabled || isCreating

  return (
    <div className="space-y-3">
      {/* Separator */}
      <div className="border-b border-gray-300" />

      {/* PR Title */}
      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">
          PR Title <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={prTitle}
          onChange={(e) => setPRTitle(e.target.value)}
          placeholder="Enter pull request title"
          disabled={isFormDisabled}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500 placeholder:text-gray-400"
        />
      </div>

      {/* PR Description */}
      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">
          PR Description
        </label>
        <MarkdownEditor
          value={prDescription}
          onChange={setPRDescription}
          disabled={isFormDisabled}
          placeholder="Describe the changes..."
        />
      </div>

      {/* Branch Name */}
      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
          Branch Name
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="text-gray-400 hover:text-gray-600 cursor-help">
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[280px]">
              The name of the new git branch that will be created for this pull request. Changes are committed to this branch and pushed to the remote before the PR is opened.
            </TooltipContent>
          </Tooltip>
        </label>
        <input
          type="text"
          value={branchName}
          onChange={(e) => setBranchName(e.target.value)}
          placeholder="runbook/..."
          disabled={isFormDisabled}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500 placeholder:text-gray-400"
        />
      </div>

      {/* Labels */}
      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">
          Labels
        </label>
        <LabelSelector
          selectedLabels={selectedLabels}
          onLabelsChange={setSelectedLabels}
          availableLabels={availableLabels}
          loading={labelsLoading}
          disabled={isFormDisabled}
        />
      </div>

      {/* Commit Message (collapsible) */}
      <div>
        <button
          type="button"
          onClick={() => setCommitMessageExpanded(!commitMessageExpanded)}
          className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 cursor-pointer"
          disabled={isFormDisabled}
        >
          {commitMessageExpanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          <span className="font-medium">Customize commit message</span>
        </button>
        {commitMessageExpanded && (
          <div className="mt-1.5">
            <input
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Changes from runbook"
              disabled={isFormDisabled}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500 placeholder:text-gray-400"
            />
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={isFormDisabled || !prTitle.trim() || !branchName.trim()}
          onClick={onSubmit}
        >
          {isCreating ? (
            <>
              <Loader2 className="size-4 mr-1 animate-spin" />
              Creating Pull Request...
            </>
          ) : (
            'Create Pull Request'
          )}
        </Button>
        {isCreating && (
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
