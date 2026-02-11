import { useState } from "react"
import { Loader2, ChevronDown, ChevronRight, Info, CircleHelp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MarkdownEditor } from "./MarkdownEditor"
import { LabelSelector } from "./LabelSelector"
import { ChangeSummaryText } from "./ChangeSummaryText"
import type { GitHubLabel, PRBlockStatus } from "../types"

export interface ChangeSummary {
  fileCount: number
  additions: number
  deletions: number
}

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
  changeSummary: ChangeSummary | null
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
  changeSummary,
  status,
  disabled,
  onSubmit,
  onCancel,
}: PRFormProps) {
  const [commitMessageExpanded, setCommitMessageExpanded] = useState(
    commitMessage !== "Changes from runbook" || !branchName.startsWith("runbook/")
  )
  const [whatFilesExpanded, setWhatFilesExpanded] = useState(false)

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

      {/* Labels — hidden when repo has none */}
      {(labelsLoading || availableLabels.length > 0) && (
        <div>
          <label className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
            Labels
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="text-gray-400 hover:text-gray-600 cursor-help">
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[280px]">
                Labels to apply to the pull request. These must already exist in the GitHub repository.
              </TooltipContent>
            </Tooltip>
          </label>
          <LabelSelector
            selectedLabels={selectedLabels}
            onLabelsChange={setSelectedLabels}
            availableLabels={availableLabels}
            loading={labelsLoading}
            disabled={isFormDisabled}
          />
        </div>
      )}

      {/* Customize commit (collapsible) */}
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
          <span className="font-medium">Customize commit</span>
        </button>
        {commitMessageExpanded && (
          <div className="mt-1.5 space-y-3">
            {/* Branch Name */}
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                Branch name
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

            {/* Commit Message */}
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                Commit message
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className="text-gray-400 hover:text-gray-600 cursor-help">
                      <Info className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[280px]">
                    The message used for the git commit. This appears in the commit history of the pull request.
                  </TooltipContent>
                </Tooltip>
              </label>
              <input
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Changes from runbook"
                disabled={isFormDisabled}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500 placeholder:text-gray-400"
              />
            </div>
          </div>
        )}
      </div>

      {/* What files will be committed? (collapsible) */}
      <div>
        <button
          type="button"
          onClick={() => setWhatFilesExpanded(!whatFilesExpanded)}
          className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 cursor-pointer"
        >
          {whatFilesExpanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          <CircleHelp className="size-3.5" />
          <span className="font-medium">What files will be committed?</span>
        </button>
        {whatFilesExpanded && (
          <div className="mt-1.5 ml-5 text-xs text-gray-600 leading-relaxed">
            {changeSummary && changeSummary.fileCount > 0 ? (
              <p className="m-0">
                This pull request will commit{' '}
                <span className="font-medium">{changeSummary.fileCount}</span>{' '}
                {changeSummary.fileCount === 1 ? 'file' : 'files'}
                <ChangeSummaryText changeSummary={changeSummary} />
                {' '}from the <span className="font-semibold">Changed files</span> tab in the workspace panel.
                Review your changes there before creating the pull request.
              </p>
            ) : (
              <p className="m-0">
                No file changes detected yet. Run a command that modifies files in the cloned repository,
                then check the <span className="font-semibold">Changed files</span> tab in the workspace panel.
              </p>
            )}
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
