import { useEffect, useState } from "react"
import {
  ArrowLeft,
  Check,
  ExternalLink,
  FilePlus2,
  FlaskConical,
  GitMerge,
  GitPullRequest,
  Loader2,
  Upload,
} from "lucide-react"
import { useApi } from "@/contexts/ApiContext"
import { Button } from "@/components/ui/button"
import { GitHubLogo } from "@/components/mdx/GitAuth/components/GitHubLogo"
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

const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary disabled:opacity-60"

/** The files the pull request adds: the rendered unit, without root.hcl, under `path`. */
function useUnitFiles(
  blockId: string,
  source: string,
  values: Record<string, unknown>,
  path: string,
  visible: boolean,
) {
  const api = useApi()
  const [files, setFiles] = useState<string[] | null>(null)
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
              .map((f) => `${path}/${f.path.slice(prefix.length)}`),
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
}

/**
 * The pull request that adds the block's Terragrunt unit to the cloned
 * repository: a title, branch, and description to start it, then the open
 * pull request, which takes later changes to the inputs and merges.
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
}: PullRequestTabProps) {
  const files = useUnitFiles(blockId, source, values, path, visible)
  // A field the person edited keeps what they wrote; the rest follow the inputs.
  const [edited, setEdited] = useState<Partial<Record<"title" | "branch" | "body", string>>>({})
  const [method, setMethod] = useState<MergeMethod>("squash")
  const title = edited.title ?? draftTitle(spec, values)
  const branch = edited.branch ?? draftBranch(title)
  const body = edited.body ?? draftBody(spec, values)
  const { state } = pr
  const busy = state.phase === "opening" || state.phase === "pushing" || state.phase === "merging"
  const applied = applyPhase === "applied"

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {target ? (
          <p className="flex items-center gap-2 text-sm text-foreground">
            <GitHubLogo className="size-4" />
            <span className="font-mono">
              {target.owner}/{target.repo}
            </span>
            <ArrowLeft className="size-3.5 text-muted-foreground" />
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {state.pr?.branch ?? branch}
            </span>
            <span className="text-muted-foreground">into</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {target.baseBranch}
            </span>
          </p>
        ) : (
          <p className="text-sm text-warning-foreground">
            Clone the repository the unit belongs in with a {"<GitClone>"} block above, and sign in
            to GitHub with a {"<GitHubAuth>"} block, to open a pull request.
          </p>
        )}
        {simulated && (
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning-muted px-2 py-0.5 text-xs text-warning-foreground">
            <FlaskConical className="size-3" /> Simulated: nothing is pushed
          </span>
        )}
      </div>

      {(state.phase === "draft" || state.phase === "opening") && (
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-card px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">Adds</p>
            <ul className="mt-1 space-y-0.5 font-mono text-xs">
              {files === null && (
                <li className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {path}/
                </li>
              )}
              {(files ?? []).map((file) => (
                <li key={file} className="flex items-center gap-1.5 text-success">
                  <FilePlus2 className="size-3.5" />
                  {file}
                </li>
              ))}
            </ul>
          </div>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-foreground">Title</span>
            <input
              className={inputClass}
              value={title}
              disabled={busy}
              onChange={(e) => setEdited((x) => ({ ...x, title: e.target.value }))}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-foreground">Branch</span>
            <input
              className={`${inputClass} font-mono`}
              value={branch}
              disabled={busy}
              onChange={(e) => setEdited((x) => ({ ...x, branch: e.target.value }))}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-foreground">Description</span>
            <textarea
              className={`${inputClass} min-h-28 font-mono text-xs`}
              value={body}
              disabled={busy}
              onChange={(e) => setEdited((x) => ({ ...x, body: e.target.value }))}
            />
          </label>
          {state.error && <p className="text-sm text-destructive">{state.error}</p>}
          {blocked ? (
            <p className="text-sm text-warning-foreground">{blocked}</p>
          ) : (
            <Button
              type="button"
              disabled={!target || busy || !title.trim() || !branch.trim()}
              onClick={() => target && void pr.open(target, { title, branch, body })}
            >
              {state.phase === "opening" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <GitPullRequest className="size-4" />
              )}
              {state.phase === "opening"
                ? "Opening the pull request…"
                : "Push and open pull request"}
            </Button>
          )}
        </div>
      )}

      {state.pr && state.phase !== "draft" && state.phase !== "opening" && (
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-card px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {state.phase === "merged" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                  <GitMerge className="size-3.5" /> Merged
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
                  <GitPullRequest className="size-3.5" /> Open
                </span>
              )}
              <a
                href={state.pr.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-w-0 items-center gap-1 font-medium text-foreground hover:underline"
              >
                <span className="truncate">{state.title}</span>
                <span className="text-muted-foreground">#{state.pr.number}</span>
                <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
              </a>
            </div>
          </div>

          {state.phase !== "merged" && pr.behind && target && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/30 bg-warning-muted px-3 py-2 text-sm text-warning-foreground">
              The inputs changed since the last push.
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || Boolean(blocked)}
                onClick={() => void pr.push(target)}
              >
                {state.phase === "pushing" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" />
                )}
                Push changes
              </Button>
            </div>
          )}

          {state.error && <p className="text-sm text-destructive">{state.error}</p>}

          {state.phase !== "merged" && target && (
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Merge method"
                value={method}
                disabled={busy}
                onChange={(e) => setMethod(e.target.value as MergeMethod)}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              >
                {MERGE_METHODS.map((m) => (
                  <option key={m.method} value={m.method}>
                    {m.label}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                disabled={busy || pr.behind}
                onClick={() => void pr.merge(target, method)}
              >
                {state.phase === "merging" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <GitMerge className="size-4" />
                )}
                {state.phase === "merging" ? "Merging…" : "Merge pull request"}
              </Button>
            </div>
          )}

          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {applied ? (
              <>
                <Check className="size-4 text-success" /> Applied from the Apply tab.
              </>
            ) : state.phase === "merged" ? (
              "Merged. Apply it from the Apply tab, unless your pipeline applies merged code."
            ) : (
              "Apply from the Apply tab before or after you merge, as your team prefers."
            )}
          </p>
        </div>
      )}

      <LogView title="Git log" log={state.log} running={busy} />
    </div>
  )
}
