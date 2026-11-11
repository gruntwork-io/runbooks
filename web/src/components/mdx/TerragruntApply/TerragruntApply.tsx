import { useMemo, useRef, type ReactNode } from "react"
import { AlertTriangle, Check, CircleHelp, ExternalLink, Loader2, Play, X } from "lucide-react"
import { useAllOutputs, useRunbookContext } from "@/contexts/useRunbook"
import {
  useComponentIdRegistry,
  usePageBlocks,
  type BlockComponentType,
} from "@/contexts/ComponentIdRegistry"
import { useGitWorkTree } from "@/contexts/useGitWorkTree"
import { useTheme } from "@/contexts/useTheme"
import { normalizeBlockId } from "@/lib/utils"
import { sensitiveOutput } from "@/lib/outputValues"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import {
  extractTemplateDependenciesFromString,
  requireAllOutputs,
} from "@/lib/extractTemplateDependencies"
import { Button } from "@/components/ui/button"
import type { AppError } from "@/types/error"
import terragruntLogo from "@/assets/terragrunt-logo.svg"
import terragruntLogoLight from "@/assets/terragrunt-logo-light.svg"
import { BlockIdLabel } from "../_shared/components/BlockIdLabel"
import { BlockLink } from "../_shared/components/BlockLink"
import { DuplicateIdError } from "../_shared/components/DuplicateIdError"
import { ErrorDisplay } from "../_shared/components/ErrorDisplay"
import { InlineMarkdown } from "../_shared/components/InlineMarkdown"
import { ProgressStep } from "../_shared/components/ProgressStep"
import { UnmetDependenciesWarning } from "../_shared/components/UnmetDependenciesWarning"
import { useTemplateDependencies } from "../_shared/hooks/useTemplateDependencies"
import { buildAuthEnvVars, buildGoogleAuthEnvVars } from "../_shared/hooks/useScriptExecution"
import { authFacts, signedIn } from "../_shared/lib/authFacts"
import { GITHUB_AUTH_ENV_VARS, GIT_AUTH_ENV_VARS } from "../../../../../src/domain/exec/authEnv"
import { revealOutputs } from "../../../../../src/domain/exec/outputValues"
import type { BoundBlock } from "../../../../../src/domain/lookups/validate"
import type { TerragruntApplyRequest } from "../../../../../electron/shared/channels"
import { PlanAndApply } from "./components/PlanAndApply"
import { usePreflight } from "./hooks/usePreflight"
import { useTerragruntRun } from "./hooks/useTerragruntRun"
import type { PreflightState } from "./preflight"

/**
 * TerragruntApply block: plans and applies one Terragrunt unit in the
 * repository a <GitClone> block cloned, whoever wrote it: a <TfModule> block,
 * a <Template> block, or a person.
 *
 * Plan first runs a preflight: the tools on the PATH, that the clone's
 * changes are pushed, and the checks the unit's module lists under
 * `preflight`, through the auth blocks `auth` lists. Then it shows the plan
 * resource by resource, applies it, and publishes the unit's outputs as the
 * block's outputs.
 *
 * @param props.id - Unique identifier for this block (required)
 * @param props.path - The unit's folder, relative to the clone's root; a template, such as `{{ .outputs.group.CODE_PATH }}` (required)
 * @param props.gitCloneId - The <GitClone> block whose clone holds the unit, needed only when the runbook has more than one
 * @param props.auth - The auth blocks Terragrunt runs with, at most one of each kind, such as `["prod", "workspace"]`
 * @param props.title - The block's title; "Apply with Terragrunt" by default
 * @param props.description - Text under the title
 */
interface TerragruntApplyProps {
  id: string
  path: string
  gitCloneId?: string
  auth?: string[]
  title?: string
  description?: string
}

/** The kinds of block `auth` can list, each giving Terragrunt its credentials. */
const AUTH_KINDS: readonly BlockComponentType[] = [
  "AwsAuth",
  "GoogleAuth",
  "GitHubAuth",
  "GitLabAuth",
  "GitAuth",
]

const NO_AUTH: string[] = []

const BLOCK_CLASS =
  "runbook-block relative mb-4 scroll-mt-4 rounded-lg border border-border bg-muted p-6 shadow-sm"

const configError = (message: string, details: string): AppError => ({ message, details })

/** What's wrong with the block's own props, before looking at the page. */
function propsError(id: string, path: string, auth: unknown): AppError | null {
  if (!id) {
    return configError(
      "The <TerragruntApply> block requires a non-empty 'id' prop.",
      "Please provide a unique 'id' for this block.",
    )
  }
  if (!path) {
    return configError(
      "The <TerragruntApply> block requires a 'path' prop.",
      "Set 'path' to the unit's folder, relative to the clone's root, such as path=\"{{ .outputs.group.CODE_PATH }}\".",
    )
  }
  if (!Array.isArray(auth) || auth.some((entry) => typeof entry !== "string")) {
    return configError(
      "The <TerragruntApply> block's 'auth' prop must be a list of auth block ids.",
      'For example, auth={["prod", "workspace"]}.',
    )
  }
  return null
}

/** The auth blocks `auth` names, or what's wrong with the list, once blocks have registered. */
function useAuthBlocks(auth: readonly string[]): { blocks: BoundBlock[]; error: AppError | null } {
  const { blockOf, registered } = usePageBlocks()
  if (!registered) return { blocks: [], error: null }
  const blocks: BoundBlock[] = []
  for (const blockId of auth) {
    const block = blockOf(blockId)
    if (!block || !AUTH_KINDS.includes(block.kind)) {
      return {
        blocks,
        error: configError(
          `The <TerragruntApply> block's auth prop names "${blockId}", which isn't an auth block in this runbook.`,
          `List the ids of auth blocks, such as an <AwsAuth> or <GoogleAuth> block, at most one of each kind.`,
        ),
      }
    }
    const twin = blocks.find((other) => other.kind === block.kind)
    if (twin) {
      return {
        blocks,
        error: configError(
          `The <TerragruntApply> block's auth prop names two ${block.kind} blocks, "${twin.id}" and "${blockId}".`,
          "Terragrunt runs with one set of credentials of each kind, so list at most one block of each kind.",
        ),
      }
    }
    blocks.push({ id: block.id, kind: block.kind, scopes: block.scopes })
  }
  return { blocks, error: null }
}

/** The <GitClone> block whose clone holds the unit, or what's wrong with the runbook's clones. */
function useCloneId(gitCloneId: string | undefined): { cloneId?: string; error: AppError | null } {
  const { blockOf, blocksOf, registered } = usePageBlocks()
  if (!registered) return { error: null }
  if (gitCloneId) {
    if (blockOf(gitCloneId)?.kind !== "GitClone") {
      return {
        error: configError(
          `The <TerragruntApply> block's gitCloneId names "${gitCloneId}", which isn't a <GitClone> block in this runbook.`,
          "Set gitCloneId to the id of the <GitClone> block whose clone holds the unit.",
        ),
      }
    }
    return { cloneId: gitCloneId, error: null }
  }
  const clones = blocksOf("GitClone")
  if (clones.length === 0) {
    return {
      error: configError(
        "The <TerragruntApply> block needs a <GitClone> block in the runbook.",
        "It applies a unit in the repository a <GitClone> block clones. Add one above it.",
      ),
    }
  }
  if (clones.length > 1) {
    return {
      error: configError(
        `The runbook has ${clones.length} <GitClone> blocks, so the <TerragruntApply> block needs a gitCloneId.`,
        `Set gitCloneId to the one whose clone holds the unit: ${clones.map((clone) => `"${clone.id}"`).join(", ")}.`,
      ),
    }
  }
  return { cloneId: clones[0]!.id, error: null }
}

function TerragruntApply({
  id,
  path,
  gitCloneId,
  auth = NO_AUTH,
  title = "Apply with Terragrunt",
  description,
}: TerragruntApplyProps) {
  const validationError = propsError(id, path, auth)
  const blockRef = useRef<HTMLDivElement>(null)
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(
    id,
    "TerragruntApply",
    blockRef,
  )
  const authList = Array.isArray(auth) ? auth : NO_AUTH
  const authBlocks = useAuthBlocks(authList)
  const clone = useCloneId(gitCloneId)
  const { workTrees } = useGitWorkTree()
  const workTree = clone.cloneId
    ? workTrees.find((tree) => normalizeBlockId(tree.id) === normalizeBlockId(clone.cloneId!))
    : undefined

  // The path waits on every output it reads, such as the <TfModule> block's CODE_PATH.
  const deps = useMemo(() => requireAllOutputs(extractTemplateDependenciesFromString(path)), [path])
  const { unmetInputDeps, unmetOutputDeps, hasAllDependencies, inputs, outputs } =
    useTemplateDependencies(deps)
  const resolvedPath = useMemo(
    () => resolveTemplateReferences(path, { inputs, outputs }),
    [path, inputs, outputs],
  )

  if (isDuplicate) {
    return (
      <DuplicateIdError
        id={id}
        isNormalizedCollision={isNormalizedCollision}
        collidingId={collidingId}
      />
    )
  }
  const error = validationError ?? clone.error ?? authBlocks.error
  if (error) return <ErrorDisplay error={error} />

  const header = <BlockHeader id={id} title={title} description={description} />
  const waiting = (children: ReactNode) => (
    <div ref={blockRef} data-testid={id} className={BLOCK_CLASS}>
      <ProgressStep done={false} />
      {header}
      {children}
    </div>
  )

  if (!hasAllDependencies) {
    return waiting(
      <UnmetDependenciesWarning
        blockType="terragrunt-apply"
        unmetInputDeps={unmetInputDeps}
        unmetOutputDeps={unmetOutputDeps}
      />,
    )
  }
  if (!clone.cloneId || !workTree) {
    return waiting(
      <Waiting>
        Clone the repository in the{" "}
        {clone.cloneId ? <BlockLink blockId={clone.cloneId} /> : "GitClone"} block above.
      </Waiting>,
    )
  }

  return (
    <div ref={blockRef} data-testid={id}>
      <Runner
        id={id}
        header={header}
        worktreePath={workTree.localPath}
        path={resolvedPath}
        auth={authBlocks.blocks}
      />
    </div>
  )
}

/** Something the block waits on, with what to do. */
function Waiting({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-muted p-3 text-sm text-warning-foreground">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
      <p className="m-0">{children}</p>
    </div>
  )
}

/** The env vars an auth block gives Terragrunt, or nothing until it's signed in. */
function envOf(
  block: BoundBlock,
  allOutputs: ReturnType<typeof useAllOutputs>,
): Record<string, string> | undefined {
  const stored = allOutputs[normalizeBlockId(block.id)]?.values
  if (!stored) return undefined
  const values = revealOutputs(stored)
  switch (block.kind) {
    case "AwsAuth":
      if (!signedIn("AwsAuth", values)) return undefined
      // The session token is passed even empty, so one from another block in the session env never mixes in.
      return {
        AWS_ACCESS_KEY_ID: values.AWS_ACCESS_KEY_ID ?? "",
        AWS_SECRET_ACCESS_KEY: values.AWS_SECRET_ACCESS_KEY ?? "",
        AWS_REGION: values.AWS_REGION ?? "",
        AWS_SESSION_TOKEN: values.AWS_SESSION_TOKEN ?? "",
      }
    case "GoogleAuth":
      return signedIn("GoogleAuth", values)
        ? buildGoogleAuthEnvVars(block.id, allOutputs)
        : undefined
    case "GitHubAuth":
      return buildAuthEnvVars(block.id, allOutputs, GITHUB_AUTH_ENV_VARS)
    default:
      return buildAuthEnvVars(block.id, allOutputs, GIT_AUTH_ENV_VARS)
  }
}

/** Who an auth block is signed in as, in words. */
function callerOf(block: BoundBlock, allOutputs: ReturnType<typeof useAllOutputs>): string {
  const values = revealOutputs(allOutputs[normalizeBlockId(block.id)]?.values ?? {})
  if (block.kind === "AwsAuth") {
    const facts = authFacts("AwsAuth", values)
    return `AWS account ${facts.accountId || "unknown"}${facts.region ? ` in ${facts.region}` : ""}`
  }
  if (block.kind === "GoogleAuth") {
    const facts = authFacts("GoogleAuth", values)
    return `Google as ${facts.email || "an unknown account"}${facts.project ? `, project ${facts.project}` : ""}`
  }
  const user = values.GITHUB_USER || values.GITLAB_USER
  return user ? `${block.kind.replace("Auth", "")} as ${user}` : block.kind.replace("Auth", "")
}

interface RunnerProps {
  id: string
  header: ReactNode
  worktreePath: string
  path: string
  auth: readonly BoundBlock[]
}

/** The preflight, the plan and the apply, once the block knows its unit and clone. */
function Runner({ id, header, worktreePath, path, auth }: RunnerProps) {
  const { registerOutputs } = useRunbookContext()
  const allOutputs = useAllOutputs()
  const envs = auth.map((block) => ({ block, env: envOf(block, allOutputs) }))
  const signedOut = envs.filter((entry) => !entry.env).map((entry) => entry.block)
  const request: TerragruntApplyRequest = {
    blockId: id,
    worktreePath,
    path,
    env: Object.assign({}, ...envs.map((entry) => entry.env ?? {})) as Record<string, string>,
  }
  const run = useTerragruntRun(request, `${worktreePath}\0${path}`)
  const preflight = usePreflight(request, auth)
  const moduleOutputs =
    preflight.state.kind === "ready" ? preflight.state.module?.outputs : undefined

  const plan = async () => {
    if ((await preflight.run()) === "go") await run.plan()
  }

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

  return (
    <div className={BLOCK_CLASS}>
      <ProgressStep done={run.status === "current"} />
      {header}
      <dl
        className="mb-4 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm"
        aria-label="What it runs"
      >
        <dt className="text-xs font-medium uppercase leading-5 tracking-wide text-muted-foreground">
          Unit
        </dt>
        <dd className="m-0 truncate font-mono text-[13px] leading-5">{path}</dd>
        <dt className="text-xs font-medium uppercase leading-5 tracking-wide text-muted-foreground">
          Runs as
        </dt>
        <dd className="m-0 text-[13px] leading-5">
          {auth.length === 0
            ? "the session's own credentials"
            : auth.map((block) => (
                <div key={block.id}>
                  {envs.find((entry) => entry.block === block)?.env ? (
                    callerOf(block, allOutputs)
                  ) : (
                    <span className="text-warning-foreground">
                      not signed in to <BlockLink blockId={block.id} />
                    </span>
                  )}
                </div>
              ))}
        </dd>
      </dl>
      {signedOut.length > 0 ? (
        <Waiting>
          Sign in with the{" "}
          {signedOut.map((block, i) => (
            <span key={block.id}>
              {i > 0 && (i === signedOut.length - 1 ? " and " : ", ")}
              <BlockLink blockId={block.id} />
            </span>
          ))}{" "}
          {signedOut.length === 1 ? "block" : "blocks"} above to plan.
        </Waiting>
      ) : (
        <PlanAndApply
          blockId={id}
          state={run.state}
          status={run.status}
          outputs={moduleOutputs ?? []}
          preflight={<Preflight state={preflight.state} onPlanAnyway={() => void run.plan()} />}
          holding={preflight.state.kind === "running"}
          onPlan={() => void plan()}
          onApply={() => void apply()}
          onCancel={run.cancel}
        />
      )}
    </div>
  )
}

/** What the preflight found, with each problem's fix. */
function Preflight({ state, onPlanAnyway }: { state: PreflightState; onPlanAnyway: () => void }) {
  switch (state.kind) {
    case "idle":
      return null
    case "running":
      return (
        <p className="m-0 flex items-center gap-2 text-sm text-foreground">
          <Loader2 className="size-4 animate-spin" /> Running the preflight checks…
        </p>
      )
    case "error":
      return (
        <Finding tone="error" title="The preflight failed">
          {state.error}
        </Finding>
      )
    case "missing-tools":
      return (
        <Finding tone="error" title="Install what the unit runs with">
          <ul className="m-0 list-none space-y-1 p-0">
            {state.tools
              .filter((tool) => !tool.found)
              .map((tool) => (
                <li key={tool.command}>
                  <code>{tool.command}</code> isn't on your PATH.{" "}
                  <a href={tool.install} target="_blank" rel="noreferrer" className="underline">
                    Install it
                  </a>
                  .
                </li>
              ))}
          </ul>
        </Finding>
      )
    case "unpushed":
      return (
        <Finding tone="error" title="Push the changes first">
          {state.message}
        </Finding>
      )
    case "ready": {
      const failed = state.results.filter((r) => r.outcome.outcome === "failed")
      const unknown = state.results.filter((r) => r.outcome.outcome === "unknown")
      const tools = state.tools.map((tool) => `${tool.command} ${tool.version ?? ""}`.trim())
      if (state.problems.length > 0) {
        return (
          <Finding tone="error" title="The auth prop doesn't fit the module's checks">
            <ul className="m-0 list-disc space-y-1 pl-5">
              {state.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Finding>
        )
      }
      if (failed.length > 0) {
        return (
          <Finding tone="error" title="A preflight check failed">
            <ul className="m-0 list-none space-y-1 p-0">
              {failed.map(({ use, outcome }) =>
                outcome.outcome === "failed" ? (
                  <li key={JSON.stringify(use)} className="flex items-start gap-2">
                    <X className="mt-0.5 size-4 shrink-0" />
                    <span>
                      {outcome.message}
                      {outcome.fix && (
                        <>
                          {" "}
                          <a
                            href={outcome.fix}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 underline"
                          >
                            Fix it <ExternalLink className="size-3" />
                          </a>
                        </>
                      )}
                    </span>
                  </li>
                ) : null,
              )}
            </ul>
          </Finding>
        )
      }
      if (unknown.length > 0 || state.moduleNote) {
        return (
          <Finding tone="warning" title="Some checks couldn't run">
            <ul className="m-0 list-none space-y-1 p-0">
              {state.moduleNote && (
                <li className="flex items-start gap-2">
                  <CircleHelp className="mt-0.5 size-4 shrink-0" />
                  {state.moduleNote}
                </li>
              )}
              {unknown.map(({ use, outcome }) => (
                <li key={JSON.stringify(use)} className="flex items-start gap-2">
                  <CircleHelp className="mt-0.5 size-4 shrink-0" />
                  <span>
                    <code>{use.from}</code>: {outcome.outcome === "unknown" ? outcome.detail : ""}
                  </span>
                </li>
              ))}
            </ul>
            <Button type="button" size="sm" className="mt-2" onClick={onPlanAnyway}>
              <Play className="size-3.5" /> Plan anyway
            </Button>
          </Finding>
        )
      }
      const passed = state.results.length
      return (
        <p className="m-0 flex items-center gap-2 text-sm text-success" title={tools.join(" · ")}>
          <Check className="size-4" />
          Preflight passed
          {passed > 0 ? `: ${passed === 1 ? "1 check" : `${passed} checks`}` : ""}, with{" "}
          {tools.join(" and ")}.
        </p>
      )
    }
  }
}

function Finding({
  tone,
  title,
  children,
}: {
  tone: "error" | "warning"
  title: string
  children: ReactNode
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-md border px-3 py-2 text-sm ${
        tone === "error"
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "border-warning/30 bg-warning-muted text-warning-foreground"
      }`}
    >
      <p className="m-0 font-medium">{title}</p>
      <div className="mt-1 text-foreground">{children}</div>
    </div>
  )
}

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

TerragruntApply.displayName = "TerragruntApply"

export default TerragruntApply
