import { useEffect, useState } from "react"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CircleHelp,
  ExternalLink,
  FileCode,
  FlaskConical,
  GitMerge,
  GitPullRequest,
  Loader2,
  Pencil,
  XCircle,
} from "lucide-react"
import { useApi } from "@/contexts/ApiContext"
import { Button } from "@/components/ui/button"
import { GitHubLogo } from "@/components/mdx/GitAuth/components/GitHubLogo"
import { MarkdownEditor } from "@/components/mdx/GitPullRequest/components/MarkdownEditor"
import { InfoTooltip } from "@/components/mdx/GitPullRequest/components/InfoTooltip"
import { CollapsibleToggle } from "@/components/mdx/GitPullRequest/components/CollapsibleToggle"
import type { TofuModuleSpec } from "../../../../../../src/domain/tofu-module/types"
import type { MergeMethod } from "../../../../../../src/services/GitHubClient"
import { unitFolder } from "../../../../../../src/domain/tofu-module/unit"
import type { PullRequestTarget, usePullRequest } from "../hooks/usePullRequest"
import type { RunState } from "../hooks/useTofuRun"
import { draftBody, draftBranch, draftTitle } from "../pullRequest"
import { LogView } from "./LogView"

/** How long the inputs must settle before the files list renders again. */
const DEBOUNCE_MS = 300

const MERGE_METHODS: { method: MergeMethod; label: string }[] = [
  { method: "squash", label: "Squash and merge" },
  { method: "merge", label: "Create a merge commit" },
  { method: "rebase", label: "Rebase and merge" },
]

const INPUT_CLASS =
  "w-full px-3 py-2 text-sm border border-input rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring disabled:bg-muted disabled:text-muted-foreground placeholder:text-muted-foreground"

/** A file the pull request adds: where it goes in the repo, and its path on the Code tab. */
interface UnitFileRef {
  readonly repoPath: string
  readonly codePath: string
}

/** The files the pull request adds: the rendered unit, without root.hcl, under `path`. */
function useUnitFiles(
  blockId: string,
  source: string,
  values: Record<string, unknown>,
  path: string,
  visible: boolean,
) {
  const api = useApi()
  const [files, setFiles] = useState<UnitFileRef[] | null>(null)
  const key = JSON.stringify(values)
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const timer = setTimeout(() => {
      api
        .invoke("tofu-module:render", { source, blockId, values: JSON.parse(key) })
        .then((result) => {
          if (cancelled) return
          const prefix = `${unitFolder(blockId)}/`
          setFiles(
            result.files
              .filter((f) => f.path.startsWith(prefix))
              .map((f) => ({
                repoPath: `${path}/${f.path.slice(prefix.length)}`,
                codePath: f.path,
              })),
          )
        })
        .catch(() => !cancelled && setFiles(null))
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [api, blockId, source, key, path, visible])
  return files
}

/** GitHub's colors for an open and a merged pull request, so the states read as they do there. */
const GITHUB_OPEN = "bg-[#1f883d] dark:bg-[#238636]"
const GITHUB_MERGED = "bg-[#8250df] dark:bg-[#8957e5]"

/** The pull request's state, as the pill at the top of a GitHub pull request shows it. */
function StatePill({ merged }: { merged: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium text-white ${
        merged ? GITHUB_MERGED : GITHUB_OPEN
      }`}
    >
      {merged ? <GitMerge className="size-3.5" /> : <GitPullRequest className="size-3.5" />}
      {merged ? "Merged" : "Open"}
    </span>
  )
}

/** A branch name, styled like GitHub's branch labels. */
function BranchName({ name }: { name: string }) {
  return (
    <code className="rounded-md bg-[#ddf4ff] px-1.5 py-0.5 font-mono text-xs text-[#0969da] dark:bg-[#388bfd26] dark:text-[#4493f8]">
      {name}
    </code>
  )
}

function ErrorPanel({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive-muted p-3">
      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0">
        <p className="m-0 text-sm font-medium text-destructive">{title}</p>
        <p className="m-0 mt-0.5 font-mono text-xs text-destructive">{message}</p>
      </div>
    </div>
  )
}

interface PullRequestTabProps {
  blockId: string
  source: string
  spec: TofuModuleSpec
  /** The block's inputs as it publishes them. */
  values: Record<string, unknown>
  /** Where the unit goes in the repository. */
  path: string
  /** The cloned repository; none until a <GitClone> block clones one. */
  target: PullRequestTarget | undefined
  simulated: boolean
  /** Why the block can't open a pull request yet, such as inputs that need a fix. */
  blocked?: string | undefined
  /** Where the Apply tab is, so the tab can say what's left. */
  applyPhase: RunState["phase"]
  pr: ReturnType<typeof usePullRequest>
  visible: boolean
  /** Shows a file, by its path on the Code tab, on the Code tab. */
  onOpenFile: (codePath: string) => void
  /** Shows the Apply tab. */
  onGoToApply: () => void
}

/**
 * The pull request that adds the block's Terragrunt unit to the cloned
 * repository, laid out like the <GitHubPullRequest> block: a title and
 * description, the branch and commit folded away, then the open pull
 * request, which takes later changes to the inputs and merges.
 */
export function PullRequestTab({
  blockId,
  source,
  spec,
  values,
  path,
  target,
  simulated,
  blocked,
  applyPhase,
  pr,
  visible,
  onOpenFile,
  onGoToApply,
}: PullRequestTabProps) {
  const files = useUnitFiles(blockId, source, values, path, visible)
  // A field the person edited keeps what they wrote; the rest follow the inputs.
  const [edited, setEdited] = useState<
    Partial<Record<"title" | "branch" | "body" | "commitMessage", string>>
  >({})
  const [commitExpanded, setCommitExpanded] = useState(false)
  const [filesExpanded, setFilesExpanded] = useState(true)
  const [method, setMethod] = useState<MergeMethod>("squash")
  const title = edited.title ?? draftTitle(spec, values)
  const branch = edited.branch ?? draftBranch(title)
  const body = edited.body ?? draftBody(spec, values)
  const commitMessage = edited.commitMessage ?? title
  const { state } = pr
  const busy =
    state.phase === "opening" ||
    state.phase === "pushing" ||
    state.phase === "updating" ||
    state.phase === "merging"
  const merged = state.phase === "merged"
  const applied = applyPhase === "applied"
  // The open pull request's title and description while the person edits them.
  const [editing, setEditing] = useState<{ title: string; body: string } | null>(null)
  const formDisabled = busy || !target || Boolean(blocked)
  const edit = (field: keyof typeof edited) => (value: string) =>
    setEdited((x) => ({ ...x, [field]: value }))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 flex items-center gap-2 text-sm font-medium text-foreground">
          <GitHubLogo className="size-4" />
          {target ? (
            <span className="font-mono">
              {target.owner}/{target.repo}
            </span>
          ) : (
            <span className="text-muted-foreground">No repository yet</span>
          )}
        </p>
        {simulated && (
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning-muted px-2 py-0.5 text-xs text-warning-foreground">
            <FlaskConical className="size-3" /> Simulated: nothing is pushed
          </span>
        )}
      </div>

      {!target && (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-muted p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div>
            <p className="m-0 text-sm font-medium text-warning-foreground">
              No repository available
            </p>
            <p className="m-0 mt-0.5 text-xs text-warning-foreground">
              Sign in with a GitHubAuth block and clone the repository with a GitClone block above.
            </p>
          </div>
        </div>
      )}

      {(state.phase === "draft" || state.phase === "opening") && (
        <div className="space-y-3">
          <div className="border-b border-border" />

          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              PR Title <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => edit("title")(e.target.value)}
              placeholder="Enter pull request title"
              disabled={formDisabled}
              className={INPUT_CLASS}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">PR Description</label>
            <MarkdownEditor
              value={body}
              onChange={edit("body")}
              disabled={formDisabled}
              placeholder="Describe the changes..."
            />
          </div>

          <CollapsibleToggle
            expanded={commitExpanded}
            onToggle={() => setCommitExpanded((x) => !x)}
            label="Customize commit"
            disabled={formDisabled}
          >
            <div className="mt-1.5 ml-2 space-y-3 border-l-2 border-border pl-3">
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
                  Branch name
                  <InfoTooltip>
                    The new branch the code is committed to and pushed, before the pull request
                    opens to merge it into {target?.baseBranch ?? "the cloned branch"}.
                  </InfoTooltip>
                </label>
                <input
                  type="text"
                  value={branch}
                  onChange={(e) => edit("branch")(e.target.value)}
                  placeholder="runbooks/..."
                  disabled={formDisabled}
                  className={`${INPUT_CLASS} font-mono`}
                />
              </div>
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
                  Commit message
                  <InfoTooltip>The message of the commit that adds the code.</InfoTooltip>
                </label>
                <input
                  type="text"
                  value={commitMessage}
                  onChange={(e) => edit("commitMessage")(e.target.value)}
                  disabled={formDisabled}
                  className={INPUT_CLASS}
                />
              </div>
            </div>
          </CollapsibleToggle>

          <CollapsibleToggle
            expanded={filesExpanded}
            onToggle={() => setFilesExpanded((x) => !x)}
            label="What files will be committed?"
            icon={<CircleHelp className="size-3.5" />}
          >
            <div className="mt-1.5 ml-5 text-xs leading-relaxed text-muted-foreground">
              {files === null ? (
                <p className="m-0 flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" /> Rendering the code…
                </p>
              ) : (
                <>
                  <p className="m-0">
                    The Terragrunt code from the Code tab, in{" "}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">{path}/</code>. Click a
                    file to see it.
                  </p>
                  <ul className="m-0 mt-1 list-none space-y-0.5 p-0">
                    {files.map((file) => (
                      <li key={file.repoPath}>
                        <button
                          type="button"
                          onClick={() => onOpenFile(file.codePath)}
                          className="inline-flex items-center gap-1.5 font-mono text-primary hover:underline"
                        >
                          <FileCode className="size-3.5" />
                          {file.repoPath}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </CollapsibleToggle>

          {state.error && <ErrorPanel title="Pull Request creation failed" message={state.error} />}
          {blocked && target && <p className="text-sm text-warning-foreground">{blocked}</p>}

          <Button
            size="sm"
            disabled={formDisabled || !title.trim() || !branch.trim()}
            onClick={() =>
              target &&
              void pr.open(target, {
                title,
                branch,
                body,
                commitMessage: commitMessage.trim() || title,
              })
            }
          >
            {state.phase === "opening" ? (
              <>
                <Loader2 className="mr-1 size-4 animate-spin" />
                Creating Pull Request...
              </>
            ) : (
              "Create Pull Request"
            )}
          </Button>
        </div>
      )}

      {state.pr && state.phase !== "draft" && state.phase !== "opening" && (
        <div className="space-y-3">
          {editing && target ? (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">
                  PR Title <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  disabled={busy}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">
                  PR Description
                </label>
                <MarkdownEditor
                  value={editing.body}
                  onChange={(text) => setEditing({ ...editing, body: text })}
                  disabled={busy}
                />
              </div>
              <p className="m-0 text-xs text-muted-foreground">
                The branch stays <BranchName name={state.pr.branch} />. To change the code, edit the
                inputs and use Git Push.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={busy || !editing.title.trim()}
                  onClick={() =>
                    void pr
                      .update(target, { title: editing.title.trim(), body: editing.body })
                      .then((ok) => ok && setEditing(null))
                  }
                >
                  {state.phase === "updating" ? (
                    <>
                      <Loader2 className="mr-1 size-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save"
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <a
                  href={state.pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group inline-flex items-baseline gap-1.5 text-base font-semibold text-foreground"
                >
                  <span className="break-words group-hover:text-primary group-hover:underline">
                    {state.title}
                  </span>
                  <span className="font-normal text-muted-foreground">#{state.pr.number}</span>
                  <ExternalLink className="size-3.5 shrink-0 self-center text-muted-foreground" />
                </a>
                {!merged && target && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setEditing({ title: state.title ?? "", body: state.body ?? "" })}
                  >
                    <Pencil className="mr-1 size-3.5" /> Edit
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StatePill merged={merged} />
                <BranchName name={target?.baseBranch ?? "main"} />
                <ArrowLeft className="size-3.5 text-muted-foreground" aria-label="from" />
                <BranchName name={state.pr.branch} />
              </div>
            </div>
          )}

          {state.error && <ErrorPanel title="That didn't work" message={state.error} />}

          {!editing && target && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-full text-white ${
                  merged ? GITHUB_MERGED : GITHUB_OPEN
                }`}
              >
                {merged ? <GitMerge className="size-4" /> : <GitPullRequest className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-foreground">
                  {merged
                    ? "Merged"
                    : pr.behind
                      ? "The inputs changed since the last push"
                      : "Ready to merge"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {merged
                    ? applied
                      ? `Merged into ${target.baseBranch}, and applied.`
                      : `Merged into ${target.baseBranch}. Apply it next, unless your pipeline applies merged code.`
                    : pr.behind
                      ? "Push them to the branch before merging."
                      : applied
                        ? "Applied from the Apply tab. Merge it to finish."
                        : "Merge now and apply after, or apply first and merge after. Either order works."}
                </div>
              </div>
              {merged && !applied && (
                <Button size="sm" onClick={onGoToApply}>
                  Apply
                  <ArrowRight className="ml-1 size-4" />
                </Button>
              )}
              {!merged &&
                (pr.behind ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || Boolean(blocked)}
                    onClick={() => void pr.push(target)}
                  >
                    {state.phase === "pushing" ? (
                      <>
                        <Loader2 className="mr-1 size-4 animate-spin" />
                        Pushing...
                      </>
                    ) : (
                      "Git Push"
                    )}
                  </Button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Merge method"
                      value={method}
                      disabled={busy}
                      onChange={(e) => setMethod(e.target.value as MergeMethod)}
                      className="h-8 rounded-md border border-input bg-card px-2 text-sm"
                    >
                      {MERGE_METHODS.map((m) => (
                        <option key={m.method} value={m.method}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <Button size="sm" disabled={busy} onClick={() => void pr.merge(target, method)}>
                      {state.phase === "merging" ? (
                        <>
                          <Loader2 className="mr-1 size-4 animate-spin" />
                          Merging...
                        </>
                      ) : (
                        "Merge Pull Request"
                      )}
                    </Button>
                    {!applied && (
                      <>
                        <span className="text-xs text-muted-foreground">or</span>
                        <Button size="sm" variant="outline" disabled={busy} onClick={onGoToApply}>
                          Apply first
                          <ArrowRight className="ml-1 size-4" />
                        </Button>
                      </>
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      <LogView title="Git log" log={state.log} running={busy} />
    </div>
  )
}
