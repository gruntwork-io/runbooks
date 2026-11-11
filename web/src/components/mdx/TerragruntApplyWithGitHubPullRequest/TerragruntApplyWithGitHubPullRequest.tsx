import { useRef, useState } from "react"
import { AlertTriangle, ArrowRight } from "lucide-react"
import { useInputs, useOutputs, useRunbookContext, flattenInputs } from "@/contexts/useRunbook"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useGitWorkTree } from "@/contexts/useGitWorkTree"
import { useIpc } from "@/hooks/useIpc"
import { revealOutput, sensitiveOutput } from "@/lib/outputValues"
import { Button } from "@/components/ui/button"
import type { AppError } from "@/types/error"
import { BlockIdLabel } from "../_shared/components/BlockIdLabel"
import { BlockLink } from "../_shared/components/BlockLink"
import { DuplicateIdError } from "../_shared/components/DuplicateIdError"
import { ErrorDisplay } from "../_shared/components/ErrorDisplay"
import { InlineMarkdown } from "../_shared/components/InlineMarkdown"
import { LoadingDisplay } from "../_shared/components/LoadingDisplay"
import { ProgressStep } from "../_shared/components/ProgressStep"
import terragruntLogo from "@/assets/terragrunt-logo.svg"
import terragruntLogoLight from "@/assets/terragrunt-logo-light.svg"
import { useTheme } from "@/contexts/useTheme"
import type { TfModuleSpec } from "../../../../../src/domain/tf-module/types"
import type { TfModuleCodeRef, TfModuleRepo } from "../../../../../electron/shared/channels"
import { CodeTab } from "./components/CodeTab"
import { ApplyTab } from "./components/ApplyTab"
import { PullRequestTab } from "./components/PullRequestTab"
import { useTfRun } from "./hooks/useTfRun"
import { useUnitCode } from "./hooks/useUnitCode"
import { usePullRequest, type PullRequestTarget } from "./hooks/usePullRequest"
import { nextFrom, stageOf, type Tab } from "./flow"
import { scrollToTop } from "./scrollToTop"

/**
 * TerragruntApplyWithGitHubPullRequest block: takes the code a <TfModule> block
 * generated, shows it, opens a GitHub pull request that adds it to the
 * repository a <GitClone> block cloned, and plans and applies it.
 *
 * Its Code tab shows the code in its folder in the repository, its PR tab
 * opens, updates and merges the pull request, and its Apply tab plans and
 * applies it with Terragrunt, so the code must be a Terragrunt unit. Merge and apply in either order. The module's outputs become the
 * block's outputs once it applies.
 *
 * @param props.id - Unique identifier for this block (required)
 * @param props.tfModuleId - The <TfModule> block whose code it applies (required)
 * @param props.title - The block's title; "Apply with a GitHub pull request" by default
 * @param props.description - Text under the title
 */
interface TerragruntApplyWithGitHubPullRequestProps {
  id: string
  tfModuleId: string
  title?: string
  description?: string
}

const TABS: { tab: Tab; label: string }[] = [
  { tab: "code", label: "Code" },
  { tab: "pr", label: "PR" },
  { tab: "apply", label: "Apply" },
]

/** What's wrong with the block's props, if anything. */
function propsError(id: string, tfModuleId: string): AppError | null {
  if (!id) {
    return {
      message: "The <TerragruntApplyWithGitHubPullRequest> block requires a non-empty 'id' prop.",
      details: "Please provide a unique 'id' for this block.",
    }
  }
  if (!tfModuleId) {
    return {
      message: "The <TerragruntApplyWithGitHubPullRequest> block requires a 'tfModuleId' prop.",
      details: "Set 'tfModuleId' to the id of the <TfModule> block whose code it applies.",
    }
  }
  return null
}

/** An output of the <TfModule> block, as text. */
function outputOf(outputs: ReturnType<typeof useOutputs>, name: string): string | undefined {
  const output = outputs?.find((o) => o.name === name)
  return output ? revealOutput(output.value) : undefined
}

function TerragruntApplyWithGitHubPullRequest({
  id,
  tfModuleId,
  title = "Apply with a GitHub pull request",
  description,
}: TerragruntApplyWithGitHubPullRequestProps) {
  const validationError = propsError(id, tfModuleId)
  const blockRef = useRef<HTMLDivElement>(null)
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(
    id,
    "TerragruntApplyWithGitHubPullRequest",
    blockRef,
  )
  const outputs = useOutputs(tfModuleId)
  const values = flattenInputs(useInputs(tfModuleId))
  const source = outputOf(outputs, "MODULE_SOURCE")
  const template = outputOf(outputs, "TEMPLATE")
  const path = outputOf(outputs, "CODE_PATH")
  const {
    data: spec,
    isLoading,
    error: apiError,
  } = useIpc<TfModuleSpec>(validationError || !source ? "" : "tf-module:read", { source })

  if (isDuplicate) {
    return (
      <DuplicateIdError
        id={id}
        isNormalizedCollision={isNormalizedCollision}
        collidingId={collidingId}
      />
    )
  }
  if (validationError) return <ErrorDisplay error={validationError} />
  if (apiError) return <ErrorDisplay error={apiError} />

  const header = <BlockHeader id={id} title={title} description={description} />

  if (!source || !template || path === undefined) {
    return (
      <div ref={blockRef} data-testid={id} className={BLOCK_CLASS}>
        <ProgressStep done={false} />
        {header}
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-muted p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div>
            <p className="m-0 text-sm font-medium text-warning-foreground">Waiting for the code</p>
            <p className="m-0 mt-0.5 text-xs text-warning-foreground">
              Generate the code in the <BlockLink blockId={tfModuleId} /> block above.
            </p>
          </div>
        </div>
      </div>
    )
  }
  if (isLoading || !spec) return <LoadingDisplay message="Reading the module..." />

  return (
    <div ref={blockRef} data-testid={id}>
      <ApplyTabs
        id={id}
        moduleId={tfModuleId}
        header={header}
        codeRef={{ source, template }}
        path={path}
        spec={spec}
        values={values}
      />
    </div>
  )
}

const BLOCK_CLASS =
  "runbook-block relative mb-4 scroll-mt-4 rounded-lg border border-border bg-muted p-6 shadow-sm"

/** The block's title, with Terragrunt's logo. */
function BlockHeader({
  id,
  title,
  description,
}: {
  id: string
  title: string
  description: string | undefined
}) {
  const { resolvedTheme } = useTheme()
  return (
    <>
      <div className="absolute right-3 top-2">
        <BlockIdLabel id={id} size="large" />
      </div>
      <div className="mb-5 flex items-start gap-3 pr-24">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card p-1.5"
          title="Terragrunt"
        >
          <img
            src={resolvedTheme === "dark" ? terragruntLogoLight : terragruntLogo}
            alt="Terragrunt"
            className="size-full object-contain"
          />
        </div>
        <div className="min-w-0">
          <div className="text-lg font-semibold text-foreground">
            <InlineMarkdown>{title}</InlineMarkdown>
          </div>
          {description && (
            <div className="text-sm text-muted-foreground">
              <InlineMarkdown>{description}</InlineMarkdown>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

interface ApplyTabsProps {
  id: string
  /** The <TfModule> block whose code this is. */
  moduleId: string
  header: React.ReactNode
  codeRef: TfModuleCodeRef
  /** The code's folder in the repository. */
  path: string
  spec: TfModuleSpec
  /** The <TfModule> block's inputs. */
  values: Record<string, unknown>
}

function ApplyTabs({ id, moduleId, header, codeRef, path, spec, values }: ApplyTabsProps) {
  const { activeWorkTree } = useGitWorkTree()
  const { registerOutputs } = useRunbookContext()
  const [tab, setTab] = useState<Tab>("code")
  const rootRef = useRef<HTMLDivElement>(null)
  // A Next button moves on to another tab, and scrolls smoothly back to the block's top to start it.
  const goTo = (next: Tab) => {
    setTab(next)
    requestAnimationFrame(() => rootRef.current && scrollToTop(rootRef.current))
  }
  // The file the Code tab shows, kept here so the PR tab can open one there.
  const [codeFile, setCodeFile] = useState<string | undefined>(undefined)

  const prTarget: PullRequestTarget | undefined = activeWorkTree
    ? {
        worktreePath: activeWorkTree.localPath,
        owner: activeWorkTree.gitInfo.repoOwner,
        repo: activeWorkTree.gitInfo.repoName,
        baseBranch: activeWorkTree.gitInfo.ref,
      }
    : undefined
  const hasRepo = prTarget !== undefined
  const repo: TfModuleRepo | undefined = prTarget && {
    worktreePath: prTarget.worktreePath,
    path,
    baseBranch: prTarget.baseBranch,
  }
  // Requests name the <TfModule> block, whose code and workspace they are.
  const run = useTfRun(moduleId, codeRef, values, repo)
  const pr = usePullRequest(moduleId, codeRef, values, path)
  const unitCode = useUnitCode(moduleId, codeRef, values, repo, tab === "code" || tab === "pr")
  const applied = run.status === "current"
  const stage = stageOf({ hasRepo, pr: pr.status, applied })

  const apply = async () => {
    const result = await run.apply()
    if (!result) return
    registerOutputs(
      id,
      Object.fromEntries(
        result.outputs.map((o) => [o.name, o.sensitive ? sensitiveOutput(o.value) : o.value]),
      ),
    )
  }

  if (unitCode.code && unitCode.code.tool !== "terragrunt") {
    return (
      <div ref={rootRef} className={BLOCK_CLASS}>
        <ProgressStep done={false} />
        {header}
        <NotTerragrunt moduleId={moduleId} template={codeRef.template} />
      </div>
    )
  }

  return (
    <div ref={rootRef} className={BLOCK_CLASS}>
      <ProgressStep done={stage === "done"} />
      {header}

      <div role="tablist" aria-label="Apply" className="mb-5 flex gap-1 border-b border-border">
        {TABS.map(({ tab: name, label }) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${id}-tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`${id}-panel-${name}`}
            onClick={() => setTab(name)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-medium ${
              tab === name
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "code" && (
        <div role="tabpanel" id={`${id}-panel-code`} aria-labelledby={`${id}-tab-code`}>
          <CodeTab
            code={unitCode.code}
            moduleFolder={codeRef.source}
            error={unitCode.error}
            repository={
              prTarget && {
                name: `${prTarget.owner}/${prTarget.repo}`,
                baseBranch: prTarget.baseBranch,
              }
            }
            selected={codeFile}
            onSelect={setCodeFile}
          />
          <div className="mt-4 border-t border-border pt-4">
            <Button type="button" onClick={() => goTo(nextFrom("code", stage, hasRepo)!.tab)}>
              Next
              <ArrowRight className="ml-1 size-4" />
            </Button>
          </div>
        </div>
      )}

      <div
        role="tabpanel"
        id={`${id}-panel-pr`}
        aria-labelledby={`${id}-tab-pr`}
        hidden={tab !== "pr"}
      >
        <PullRequestTab
          blockId={id}
          code={unitCode.code}
          spec={spec}
          values={values}
          path={path}
          target={prTarget}
          applied={applied}
          next={nextFrom("pr", stage, hasRepo)}
          pr={pr}
          onOpenFile={(file) => {
            setCodeFile(file)
            setTab("code")
          }}
          onNavigate={goTo}
        />
      </div>

      {/* Kept mounted, so a plan or apply keeps going while another tab shows. */}
      <div
        role="tabpanel"
        id={`${id}-panel-apply`}
        aria-labelledby={`${id}-tab-apply`}
        hidden={tab !== "apply"}
      >
        <ApplyTab
          blockId={id}
          state={run.state}
          status={run.status}
          outputs={spec.outputs}
          next={nextFrom("apply", stage, hasRepo)}
          onNavigate={goTo}
          onPlan={() => void run.plan()}
          onApply={() => void apply()}
          onCancel={run.cancel}
        />
      </div>
    </div>
  )
}

/** Shown when the <TfModule> block's template makes plain OpenTofu or Terraform code. */
function NotTerragrunt({ moduleId, template }: { moduleId: string; template: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
    >
      <p className="m-0 font-medium text-destructive">This block applies Terragrunt units only</p>
      <p className="m-0 mt-1 text-foreground">
        The <BlockLink blockId={moduleId} /> block's template, <code>{template}</code>, makes no{" "}
        <code>terragrunt.hcl</code>. Give it a template that renders a Terragrunt unit.
      </p>
    </div>
  )
}

TerragruntApplyWithGitHubPullRequest.displayName = "TerragruntApplyWithGitHubPullRequest"

export default TerragruntApplyWithGitHubPullRequest
