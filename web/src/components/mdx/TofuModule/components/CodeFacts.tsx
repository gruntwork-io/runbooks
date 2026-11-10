import type { ReactNode } from "react"
import { Database, ExternalLink, GitBranch, Package, TriangleAlert } from "lucide-react"
import { GitHubLogo } from "@/components/mdx/GitAuth/components/GitHubLogo"
import { moduleSourceInfo } from "../../../../../../src/domain/tofu-module/moduleSource"
import type { TofuModuleCode } from "../../../../../../electron/shared/channels"

interface CodeFactsProps {
  code: TofuModuleCode
  /** The block's `source` prop, the module's folder. */
  moduleFolder: string
  /** The repository the code goes to, as `owner/repo`, and the branch it's compared with. */
  repository: { name: string; baseBranch: string } | undefined
}

/** The repository the block's code goes to, the branch it's compared with, and the module it uses. */
export function CodeFacts({ code, moduleFolder, repository }: CodeFactsProps) {
  const repo = code.kind === "repo"
  return (
    <dl
      className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm"
      aria-label="Where the code goes"
    >
      <Fact label="Repository" icon={<GitHubLogo className="size-3.5" />}>
        {repo && repository ? (
          repository.name
        ) : (
          <span className="text-muted-foreground">none: add a GitClone block</span>
        )}
      </Fact>
      {repo && repository && (
        <Fact label="Compared with" icon={<GitBranch className="size-3.5" />}>
          {repository.baseBranch}
        </Fact>
      )}
      <Fact label="Module" icon={<Package className="size-3.5" />}>
        <Module source={repo ? code.source : undefined} folder={moduleFolder} warn={repo} />
      </Fact>
      {repo && !code.rootHcl && (
        <Fact label="State" icon={<Database className="size-3.5" />}>
          <span className="flex items-center gap-1.5">
            local, beside the unit
            <Warning text="The repository has no root.hcl above this folder, so Apply runs the unit beside one Runbooks writes, which keeps state on this computer." />
          </span>
        </Fact>
      )}
    </dl>
  )
}

/** The module by name, linked to its folder on GitHub, with the ref it's pinned to. */
function Module({
  source,
  folder,
  warn,
}: {
  source: string | undefined
  folder: string
  warn: boolean
}) {
  if (!source) {
    return (
      <span className="flex items-center gap-1.5">
        {folder.split("/").filter(Boolean).at(-1) ?? folder}
        {warn && (
          <Warning text="A folder on this computer. Add a pinned source to runbooks.yml so the code works anywhere." />
        )}
      </span>
    )
  }
  const info = moduleSourceInfo(source)
  return (
    <span className="flex items-center gap-2" title={source}>
      {info.url ? (
        <a
          href={info.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          {info.name}
          <ExternalLink className="size-3" />
        </a>
      ) : (
        info.name
      )}
      {info.ref && <span className="text-xs text-muted-foreground">{info.ref}</span>}
    </span>
  )
}

function Warning({ text }: { text: string }) {
  return (
    <span title={text} className="shrink-0 text-warning-foreground">
      <TriangleAlert className="size-3.5" aria-label={text} />
    </span>
  )
}

function Fact({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs font-medium uppercase leading-5 tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="m-0 flex min-w-0 items-center gap-1.5 font-mono text-[13px] leading-5 text-foreground">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 truncate">{children}</span>
      </dd>
    </>
  )
}
