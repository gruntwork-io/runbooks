import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  GitCommit,
  ListChecks,
  Loader2,
  XCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  BlockIdLabel,
  InlineMarkdown,
  UnmetDependenciesWarning,
  ViewLogs,
  ViewOutputs,
} from "@/components/mdx/_shared"
import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { BlockLink } from "@/components/mdx/_shared/components/BlockLink"
import { ProgressStep } from "@/components/mdx/_shared/components/ProgressStep"
import { useClone } from "@/components/mdx/_shared/hooks/useClone"
import { useTemplateDependencies } from "@/components/mdx/_shared/hooks/useTemplateDependencies"
import { deriveProviderFromRepoUrl } from "@/components/mdx/_shared/lib/gitProvider"
import {
  ChangedFilesView,
  type FileSelection,
} from "@/components/artifacts/workspace/ChangedFilesView"
import { CollapsibleToggle } from "@/components/mdx/GitPullRequest/components/CollapsibleToggle"
import { MergeControl } from "@/components/mdx/GitPullRequest/components/MergeControl"
import { usePrMerge } from "@/components/mdx/GitPullRequest/hooks/usePrMerge"
import {
  knownMergeConditions,
  mergeConditionsError,
  unmetMergeCondition,
} from "@/components/mdx/GitPullRequest/mergeConditions"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useGitWorkTree } from "@/contexts/useGitWorkTree"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useCloneChanges } from "@/hooks/useGitFileChanges"
import {
  extractTemplateDependenciesFromString,
  requireAllOutputs,
} from "@/lib/extractTemplateDependencies"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import { normalizeBlockId } from "@/lib/utils"
import type { AppError } from "@/types/error"
import { useCommitPush } from "./hooks/useCommitPush"
import { usePullRequestTarget } from "./hooks/usePullRequestTarget"
import { startsSelected, suggestCommitMessage } from "./selection"
import type { GitCommitPushProps } from "./types"

const BLOCK = "<GitCommitPush>"

/**
 * Commits the files the user chooses from a clone's changes, then pushes:
 * onto a pull request's branch, or the branch the clone is on.
 */
function GitCommitPush({
  id,
  title = "Commit and push",
  description,
  pullRequestId,
  gitCloneId,
  commitMessage: commitMessageProp,
  selectedPaths,
  changedFilesExpanded = false,
  allowPullRequestMerge = false,
  allowPullRequestMergeConditions = [],
}: GitCommitPushProps) {
  const blockRef = useRef<HTMLDivElement>(null)
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(
    id,
    "GitCommitPush",
    blockRef,
  )
  const { reportError, clearError } = useErrorReporting()
  const { registerOutputs } = useRunbookContext()
  const { workTrees, activeWorkTree, invalidateGitFileTree } = useGitWorkTree()

  // Where the commit goes: the pull request's clone and branch, or a clone's own branch.
  const target = usePullRequestTarget(pullRequestId, BLOCK)
  const clone = useClone(gitCloneId, {
    id,
    block: BLOCK,
    holds: "the changes to commit",
    activeWithoutClone: true,
  })
  const prCloneId = target.place?.cloneId
  const workTree = pullRequestId
    ? prCloneId
      ? workTrees.find((tree) => normalizeBlockId(tree.id) === normalizeBlockId(prCloneId))
      : target.place
        ? (activeWorkTree ?? undefined)
        : undefined
    : clone.workTree
  const cloneId = pullRequestId ? prCloneId : clone.cloneId
  const provider =
    target.place?.provider ?? deriveProviderFromRepoUrl(workTree?.gitInfo?.repoUrl) ?? "github"

  // Template expressions in the message and paths wait for what they name.
  const dependencies = useMemo(
    () =>
      requireAllOutputs(
        extractTemplateDependenciesFromString(commitMessageProp ?? "", ...(selectedPaths ?? [])),
      ),
    [commitMessageProp, selectedPaths],
  )
  const { unmetInputDeps, unmetOutputDeps, hasAllDependencies, inputs, outputs } =
    useTemplateDependencies(dependencies)
  const templateCtx = useMemo(() => ({ inputs, outputs }), [inputs, outputs])
  const resolvedPaths = useMemo(
    () => selectedPaths?.map((p) => resolveTemplateReferences(p, templateCtx)),
    [selectedPaths, templateCtx],
  )
  const resolvedMessage = commitMessageProp
    ? resolveTemplateReferences(commitMessageProp, templateCtx)
    : undefined

  // The clone's changes, and the ones the user has chosen
  const changes = useCloneChanges(workTree?.localPath)
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map())
  const isSelected = useCallback(
    (path: string) => choices.get(path) ?? startsSelected(resolvedPaths, path),
    [choices, resolvedPaths],
  )
  const chosen = useMemo(
    () => changes.changes.filter((c) => isSelected(c.path)),
    [changes.changes, isSelected],
  )

  // The message follows the chosen files until the user edits it.
  const [typedMessage, setTypedMessage] = useState<string>()
  const message = typedMessage ?? resolvedMessage ?? suggestCommitMessage(chosen)

  const commitPush = useCommitPush()
  const pushed = commitPush.pushed

  // Merging the pull request, when the runbook allows it
  const mergeEnabled = allowPullRequestMerge && provider === "github" && !!pullRequestId
  const prRef = useMemo(
    () =>
      mergeEnabled && target.pr && workTree
        ? {
            worktreePath: workTree.localPath,
            owner: workTree.gitInfo.repoOwner,
            repo: workTree.gitInfo.repoName,
            number: target.pr.number,
          }
        : undefined,
    [mergeEnabled, target.pr, workTree],
  )
  const prMerge = usePrMerge(prRef)
  const merged = prMerge.state?.state === "merged"
  const mergeBlockedBy = unmetMergeCondition(
    knownMergeConditions(allowPullRequestMergeConditions),
    {
      uncommittedFiles: changes.totalChanges,
      checking: changes.isLoading,
    },
  )

  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: "GitCommitPush",
        severity: "error",
        message: `Duplicate GitCommitPush block ID: "${id}"`,
      })
    } else if (isNormalizedCollision) {
      reportError({
        componentId: id,
        componentType: "GitCommitPush",
        severity: "error",
        message: `GitCommitPush ID "${id}" collides with "${collidingId}" after normalization`,
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, isNormalizedCollision, collidingId, reportError, clearError])

  const handlePush = useCallback(async () => {
    if (!workTree) return
    const done = await commitPush.run({
      worktreePath: workTree.localPath,
      ...(target.pr ? { branchName: target.pr.branch } : {}),
      commitMessage: message.trim(),
      paths: chosen.map((c) => c.path),
      provider,
    })
    invalidateGitFileTree()
    if (!done) return
    registerOutputs(id, {
      BRANCH: done.branch,
      ...(done.commitSha ? { COMMIT_SHA: done.commitSha } : {}),
      ...(target.pr ? { PR_URL: target.pr.url } : {}),
    })
    // The next commit starts from the files that change after this one.
    setChoices(new Map())
    setTypedMessage(undefined)
  }, [
    workTree,
    commitPush,
    target.pr,
    message,
    chosen,
    provider,
    invalidateGitFileTree,
    registerOutputs,
    id,
  ])

  const selection: FileSelection = useMemo(
    () => ({
      isSelected,
      setSelected: (paths, selected) =>
        setChoices((prev) => {
          const next = new Map(prev)
          for (const path of paths) next.set(path, selected)
          return next
        }),
      disabled: commitPush.running,
    }),
    [isSelected, commitPush.running],
  )
  const [filesExpanded, setFilesExpanded] = useState(changedFilesExpanded)

  const configError: AppError | null =
    (!id
      ? {
          message: `The ${BLOCK} component requires a non-empty 'id' prop.`,
          details: "Please provide a unique 'id' for this component instance.",
        }
      : null) ??
    (pullRequestId && gitCloneId
      ? {
          message: `The ${BLOCK} block takes pullRequestId or gitCloneId, not both.`,
          details: "With pullRequestId it works in the pull request's clone, so remove gitCloneId.",
        }
      : null) ??
    target.error ??
    (pullRequestId ? null : clone.error) ??
    (allowPullRequestMerge && !pullRequestId
      ? {
          message: `The ${BLOCK} block's allowPullRequestMerge needs pullRequestId.`,
          details: "Set pullRequestId to the pull request block whose pull request it may merge.",
        }
      : null) ??
    (allowPullRequestMerge && target.place && target.place.provider !== "github"
      ? {
          message: `The ${BLOCK} block's allowPullRequestMerge works with GitHub only.`,
          details: "Remove allowPullRequestMerge, and merge the merge request on GitLab.",
        }
      : null) ??
    mergeConditionsError("GitCommitPush", allowPullRequestMerge, allowPullRequestMergeConditions)

  // Kept on the page in the block's place, so the clones above it can still be found.
  if (configError) {
    return (
      <div ref={blockRef}>
        <ErrorDisplay error={configError} />
      </div>
    )
  }
  if (isDuplicate || isNormalizedCollision) return null

  const waitingFor: { what: string; blockId: string | undefined; how: string } | undefined =
    !workTree
      ? { what: "the clone", blockId: cloneId, how: "Clone the repository in the" }
      : pullRequestId && !target.pr
        ? {
            what: "the pull request",
            blockId: pullRequestId,
            how: "Open the pull request in the",
          }
        : undefined
  const ready = !waitingFor && hasAllDependencies && !merged
  const count = chosen.length
  const buttonLabel =
    count === 0 ? "Push" : `Commit and push ${count} ${count === 1 ? "file" : "files"}`
  const done = pushed !== undefined
  const statusClasses = commitPush.error
    ? "bg-destructive-muted border-destructive/30"
    : done
      ? "bg-success-muted border-success/30"
      : "bg-muted border-border"

  return (
    <div
      ref={blockRef}
      data-testid={id}
      className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}
    >
      <ProgressStep done={done} />
      <div className="absolute top-3 right-3 z-20 flex items-center gap-1">
        <BlockIdLabel id={id} size="large" />
      </div>

      <div className="flex @container">
        <div className="border-r border-border pr-2 mr-4 flex flex-col items-center">
          {commitPush.running ? (
            <Loader2 className="size-6 text-info animate-spin" />
          ) : done ? (
            <CheckCircle className="size-6 text-success" />
          ) : (
            <GitCommit className="size-6 text-muted-foreground" />
          )}
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex items-center gap-1 text-md font-bold text-foreground">
            <InlineMarkdown>{title}</InlineMarkdown>
          </div>
          <div className="text-md text-muted-foreground">
            <InlineMarkdown>
              {description ??
                (pullRequestId
                  ? "Commit the files you choose to the pull request, and push them."
                  : "Commit the files you choose, and push them.")}
            </InlineMarkdown>
          </div>

          {waitingFor && (
            <div className="p-3 bg-warning-muted border border-warning/30 rounded-md flex items-start gap-2">
              <AlertTriangle className="size-4 text-warning mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-warning-foreground m-0">
                  Waiting for {waitingFor.what}
                </p>
                <p className="text-xs text-warning-foreground m-0 mt-0.5">
                  {waitingFor.how}{" "}
                  {waitingFor.blockId ? <BlockLink blockId={waitingFor.blockId} /> : "GitClone"}{" "}
                  block above.
                </p>
              </div>
            </div>
          )}

          {!hasAllDependencies && (
            <UnmetDependenciesWarning
              blockType="commit"
              unmetInputDeps={unmetInputDeps}
              unmetOutputDeps={unmetOutputDeps}
            />
          )}

          {target.pr && (
            <div
              data-testid="commit-push-pr"
              className="bg-card border border-border rounded-md p-3 space-y-2"
            >
              <a
                href={target.pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <span>
                  {provider === "gitlab" ? "Merge request !" : "Pull request #"}
                  {target.pr.number}
                </span>
                <ExternalLink className="size-3.5 shrink-0" />
              </a>
              <div className="text-xs text-muted-foreground">
                Commits to{" "}
                <code className="bg-muted px-1 py-0.5 rounded font-mono">{target.pr.branch}</code>
              </div>
              {prRef && (
                <MergeControl
                  merge={prMerge}
                  {...(mergeBlockedBy ? { blockedBy: mergeBlockedBy } : {})}
                />
              )}
            </div>
          )}

          {!waitingFor && (
            <>
              <CollapsibleToggle
                expanded={filesExpanded}
                onToggle={() => setFilesExpanded(!filesExpanded)}
                label={
                  changes.isLoading && changes.changes.length === 0
                    ? "Checking for changes..."
                    : `${count} of ${changes.totalChanges} changed ${changes.totalChanges === 1 ? "file" : "files"} chosen`
                }
                icon={<ListChecks className="size-3.5" />}
              >
                <div
                  className="mt-2 h-80 overflow-hidden rounded-md border border-border bg-card"
                  data-testid="commit-push-files"
                >
                  <ChangedFilesView
                    changes={changes.changes}
                    tooManyChanges={changes.tooManyChanges}
                    totalChanges={changes.totalChanges}
                    isLoading={changes.isLoading}
                    onLoadDiff={changes.fetchFileDiff}
                    letters
                    selection={selection}
                  />
                </div>
              </CollapsibleToggle>

              <label className="block space-y-1">
                <span className="text-sm font-medium text-foreground">Commit message</span>
                <input
                  type="text"
                  value={message}
                  onChange={(e) => setTypedMessage(e.target.value)}
                  disabled={commitPush.running || count === 0}
                  placeholder={count === 0 ? "Choose files to commit" : undefined}
                  className="w-full px-3 py-2 text-sm border border-input rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                />
              </label>

              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  onClick={() => void handlePush()}
                  disabled={!ready || commitPush.running || (count > 0 && message.trim() === "")}
                >
                  {commitPush.running ? (
                    <>
                      <Loader2 className="size-4 mr-1 animate-spin" />
                      Pushing...
                    </>
                  ) : (
                    buttonLabel
                  )}
                </Button>
                {!target.pr && (
                  <span className="text-xs text-muted-foreground">
                    to the branch the clone is on
                  </span>
                )}
              </div>
              {count === 0 && !merged && (
                <p className="text-xs text-muted-foreground m-0">
                  No files chosen, so Push sends only the commits already made.
                </p>
              )}
              {merged && (
                <p className="text-xs text-muted-foreground m-0">
                  The pull request is merged, so its branch takes no more pushes.
                </p>
              )}
            </>
          )}

          {commitPush.error && (
            <div className="p-3 bg-destructive-muted border border-destructive/30 rounded-md flex items-start gap-2">
              <XCircle className="size-4 text-destructive mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-destructive m-0">Push failed</p>
                <p className="text-xs text-destructive m-0 mt-0.5 font-mono">{commitPush.error}</p>
              </div>
            </div>
          )}

          {pushed && !commitPush.error && !commitPush.running && (
            <div
              data-testid="commit-push-result"
              className="flex items-center gap-2 text-sm text-success font-medium"
            >
              <CheckCircle className="size-4" />
              {pushed.committed ? "Committed and pushed" : "Pushed"} to{" "}
              <code className="font-mono text-xs">{pushed.branch}</code>
              {pushed.commitSha && (
                <code className="font-mono text-xs">{pushed.commitSha.slice(0, 7)}</code>
              )}
            </div>
          )}
        </div>
      </div>

      {commitPush.logs.length > 0 && (
        <div className="mt-4">
          <ViewLogs
            logs={commitPush.logs}
            status={
              commitPush.running
                ? "running"
                : commitPush.error
                  ? "fail"
                  : done
                    ? "success"
                    : "pending"
            }
            autoOpen={commitPush.running}
            blockId={id}
          />
        </div>
      )}
      {pushed && (
        <div className="mt-2">
          <ViewOutputs
            outputs={{
              BRANCH: pushed.branch,
              ...(pushed.commitSha ? { COMMIT_SHA: pushed.commitSha } : {}),
              ...(target.pr ? { PR_URL: target.pr.url } : {}),
            }}
          />
        </div>
      )}
    </div>
  )
}

GitCommitPush.displayName = "GitCommitPush"

export { GitCommitPush }
export default GitCommitPush
