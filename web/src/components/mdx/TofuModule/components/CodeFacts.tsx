import type { ReactNode } from "react"
import { Database, FolderOpen, GitBranch, Package, TriangleAlert } from "lucide-react"
import { GitHubLogo } from "@/components/mdx/GitAuth/components/GitHubLogo"
import {
  renderRowTemplate,
  type LookupRow,
} from "../../../../../../src/domain/tofu-module/rowTemplate"
import { unitFolder } from "../../../../../../src/domain/tofu-module/unit"
import type { TofuModuleCode } from "../../../../../../electron/shared/channels"

/** A piece of a rendered template: literal text, or the value of the input it reads. */
export interface TemplatePart {
  readonly text: string
  /** The input the text came from, for the parts a template filled in. */
  readonly field?: string
}

const TOKEN = /\{\{-?\s*\.([A-Za-z_]\w*)\s*-?\}\}/g

/**
 * A template rendered as its parts, so the values it filled in can stand out
 * from its literal text. A template that does more than read fields renders
 * as one part.
 */
export function templateParts(template: string, values: LookupRow): TemplatePart[] {
  const withoutFields = template.replace(TOKEN, "")
  if (withoutFields.includes("{{")) {
    return [{ text: renderRowTemplate(template, values) }]
  }
  const parts: TemplatePart[] = []
  let last = 0
  for (const match of template.matchAll(TOKEN)) {
    if (match.index > last) parts.push({ text: template.slice(last, match.index) })
    const field = match[1]!
    parts.push({ text: renderRowTemplate(`{{ .${field} }}`, values), field })
    last = match.index + match[0].length
  }
  if (last < template.length) parts.push({ text: template.slice(last) })
  return parts
}

interface CodeFactsProps {
  code: TofuModuleCode
  blockId: string
  values: LookupRow
  /** The block's `path` prop, a template over the inputs; the block's id without one. */
  pathTemplate: string | undefined
  /** The block's `source` prop, the module's folder. */
  moduleFolder: string
  /** The repository the code goes to, as `owner/repo`, and the branch it's compared with. */
  repository: { name: string; baseBranch: string } | undefined
  simulated: boolean
}

/**
 * Where the block's code goes and what it points at, one value to a row, each
 * with where it came from: the repository a GitClone block cloned, the
 * block's `path` with the inputs it reads marked, and the module's source.
 */
export function CodeFacts({
  code,
  blockId,
  values,
  pathTemplate,
  moduleFolder,
  repository,
  simulated,
}: CodeFactsProps) {
  const cloned = simulated ? "simulation.yml" : "<GitClone>"
  return (
    <dl
      className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)_max-content]"
      aria-label="Where the code goes"
    >
      {code.kind === "repo" ? (
        <>
          <Fact
            label="Repository"
            icon={<GitHubLogo className="size-3.5" />}
            value={repository?.name ?? "—"}
            from={cloned}
          />
          <Fact
            label="Compared with"
            icon={<GitBranch className="size-3.5" />}
            value={repository?.baseBranch ?? "—"}
            from={simulated ? "simulation.yml" : "the branch <GitClone> checked out"}
          />
          <Fact
            label="Folder"
            icon={<FolderOpen className="size-3.5" />}
            value={<Template template={pathTemplate ?? blockId} values={values} />}
            from={pathTemplate ? `path="${pathTemplate}"` : "the block's id"}
          />
          <Fact
            label="Module"
            icon={<Package className="size-3.5" />}
            value={code.source ?? moduleFolder}
            from={code.source ? "runbooks.yml › source" : `source="${moduleFolder}"`}
            warning={
              code.source
                ? undefined
                : "A folder on this computer. Add a pinned source to runbooks.yml so the code works anywhere."
            }
          />
          {!code.rootHcl && (
            <Fact
              label="State"
              icon={<Database className="size-3.5" />}
              value="local, beside the unit"
              from="no root.hcl above the folder"
              warning="Apply runs the unit beside a root.hcl Runbooks writes, which keeps state on this computer."
            />
          )}
        </>
      ) : (
        <>
          <Fact
            label="Repository"
            icon={<GitHubLogo className="size-3.5" />}
            value="none"
            from="add a <GitClone> block"
            muted
          />
          <Fact
            label="Folder"
            icon={<FolderOpen className="size-3.5" />}
            value={`.runbooks/tofu-module/${unitFolder(blockId)}`}
            from="the block's workspace"
          />
          <Fact
            label="Module"
            icon={<Package className="size-3.5" />}
            value={moduleFolder}
            from={`source="${moduleFolder}"`}
          />
        </>
      )}
    </dl>
  )
}

function Fact({
  label,
  icon,
  value,
  from,
  warning,
  muted = false,
}: {
  label: string
  icon: ReactNode
  value: ReactNode
  from: string
  warning?: string | undefined
  muted?: boolean
}) {
  return (
    <>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground leading-5">
        {label}
      </dt>
      <dd className="m-0 flex min-w-0 items-center gap-1.5 font-mono text-[13px] leading-5">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span
          title={typeof value === "string" ? value : undefined}
          className={`truncate ${muted ? "text-muted-foreground" : "text-foreground"}`}
        >
          {value}
        </span>
        {warning && (
          <span title={warning} className="shrink-0 text-warning-foreground">
            <TriangleAlert className="size-3.5" aria-label={warning} />
          </span>
        )}
      </dd>
      <dd className="col-span-2 m-0 -mt-1 truncate pl-0 font-mono text-[11px] leading-5 text-muted-foreground sm:col-span-1 sm:mt-0 sm:text-right">
        <span className="sm:hidden">from </span>
        {from}
      </dd>
    </>
  )
}

/** A rendered template, with each value it filled in from an input marked and named. */
function Template({ template, values }: { template: string; values: LookupRow }) {
  return (
    <>
      {templateParts(template, values).map((part, i) =>
        part.field ? (
          <mark
            key={i}
            title={`.${part.field}`}
            className="rounded bg-info-muted px-0.5 text-foreground"
          >
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  )
}
