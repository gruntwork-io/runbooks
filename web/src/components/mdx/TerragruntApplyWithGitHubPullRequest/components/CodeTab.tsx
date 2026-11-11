import { useState } from "react"
import { Check, Copy, Loader2, Maximize2 } from "lucide-react"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { coy } from "react-syntax-highlighter/dist/esm/styles/prism"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { PRISM_LINE_NUMBER_STYLE } from "@/lib/prismStyles"
import { cn } from "@/lib/utils"
import { DiffTable } from "@/components/artifacts/code/DiffTable"
import {
  FileTree,
  type ChangeLabels,
  type FileTreeNode,
} from "@/components/artifacts/code/FileTree"
import { CodeFacts } from "./CodeFacts"
import { lineChanges, type FileChange } from "@/lib/fileReview"
import { diffDiskContents } from "@/lib/unifiedDiff"
import type { TfModuleCode } from "../../../../../../electron/shared/channels"
import type { RepoFile, UnitFile } from "../../../../../../src/domain/tf-module/unit"

interface CodeTabProps {
  code: TfModuleCode | null
  /** The <TfModule> block's `source` prop, the module's folder. */
  moduleFolder: string
  error: string | null
  /** The repository the code goes to, as `owner/repo`, and the branch it's compared with. */
  repository?: { name: string; baseBranch: string } | undefined
  /** The file shown, by its path; the unit's terragrunt.hcl until one is picked. */
  selected?: string | undefined
  onSelect: (path: string) => void
}

/** A file's language for the highlighter, from its name. */
function languageOf(path: string): string {
  if (/\.(hcl|tf|tofu)$/.test(path)) return "hcl"
  if (/\.ya?ml$/.test(path)) return "yaml"
  if (path.endsWith(".json")) return "json"
  return "text"
}

/** A file in the repository the code doesn't change, shown dimmed. */
const isContext = (file: UnitFile) => "status" in file && (file as RepoFile).status === "context"

/** The files as the tree shows them: folders from their paths, each holding its files. */
function treeOf(files: readonly UnitFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = []
  for (const file of files) {
    const parts = file.path.split("/")
    let level = root
    parts.slice(0, -1).forEach((part, i) => {
      const id = parts.slice(0, i + 1).join("/")
      let folder = level.find((node) => node.id === id)
      if (!folder) {
        folder = { id, name: part, type: "folder", children: [] }
        level.push(folder)
      }
      level = folder.children!
    })
    level.push({
      id: file.path,
      name: parts.at(-1)!,
      type: "file",
      isIgnored: isContext(file),
      file: {
        name: parts.at(-1)!,
        path: file.path,
        content: file.content,
        language: languageOf(file.path),
        size: file.content.length,
      },
    })
  }
  // Folders first, as a file browser lists them.
  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1,
    )
    for (const node of nodes) if (node.children) sort(node.children)
  }
  sort(root)
  return root
}

/** Every folder in the files' paths, so the tree opens all the way down to the unit. */
function foldersOf(files: readonly UnitFile[]): string[] {
  return [
    ...new Set(
      files.flatMap((f) => {
        const parts = f.path.split("/").slice(0, -1)
        return parts.map((_, i) => parts.slice(0, i + 1).join("/"))
      }),
    ),
  ]
}

/** The marks the tree shows for the files the code adds or changes in the repository. */
function repoChanges(files: readonly RepoFile[]): Map<string, FileChange> {
  const changes = new Map<string, FileChange>()
  for (const file of files) {
    if (file.status === "added") {
      changes.set(file.path, { ...lineChanges("", file.content), status: "added" })
    } else if (file.status === "modified") {
      changes.set(file.path, lineChanges(file.before ?? "", file.content))
    }
  }
  return changes
}

/**
 * The code the block runs: the runbook's template rendered with the inputs as
 * they are now. With a repository, the code sits in its folder there, among
 * the files above it that it may include; without one, it sits in the block's
 * workspace, beside a root.hcl when it's a Terragrunt unit.
 */
export function CodeTab({
  code,
  moduleFolder,
  error,
  repository,
  selected,
  onSelect,
}: CodeTabProps) {
  const [maximized, setMaximized] = useState(false)
  // Whether a changed file shows whole rather than as its changes, the same full screen or not.
  const [whole, setWhole] = useState(false)
  const files: readonly UnitFile[] = code?.files ?? []
  const tree = treeOf(files)
  const folders = foldersOf(files)
  const changes = code?.kind === "repo" ? repoChanges(code.files) : undefined
  // The code's main file, rather than a file beside or above it, unless the user picked one.
  const own = files.filter((f) => !isContext(f) && f.path !== "root.hcl")
  const shown =
    files.find((f) => f.path === selected) ??
    own.find((f) => f.path.endsWith("/terragrunt.hcl")) ??
    own.find((f) => f.path.endsWith("/main.tf")) ??
    own[0] ??
    files[0]

  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        {error}
      </div>
    )
  }
  if (!code || !shown) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Rendering the module's template…
      </div>
    )
  }

  const base = repository?.baseBranch ?? "the base branch"
  const labels: ChangeLabels = {
    added: `New: not on ${base}`,
    modified: `Changes the file on ${base}`,
    folder: "Holds files this code adds or changes",
  }

  const browser = (inDialog: boolean) => (
    <div
      className={cn(
        "flex flex-col gap-3 md:flex-row",
        inDialog ? "min-h-0 flex-1" : "md:h-[26rem]",
      )}
    >
      <div className="flex shrink-0 flex-col overflow-hidden rounded-md border border-border bg-card md:w-64">
        <div className="min-h-0 flex-1 overflow-auto py-1 pr-2">
          <FileTree
            items={tree}
            selectedId={shown.path}
            defaultExpandedIds={folders}
            changes={changes}
            changeLabels={labels}
            onItemClick={(item) => {
              if (item.type === "file") onSelect(item.id)
            }}
          />
        </div>
        {code.kind === "repo" && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
            <span>
              <span className="font-semibold text-success">A</span> new
            </span>
            <span>
              <span className="font-semibold text-warning-foreground">M</span> changed
            </span>
            <span className="opacity-60">dimmed: context</span>
          </div>
        )}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5" data-testid="tf-module-code">
        <ShownFile
          file={shown}
          base={base}
          whole={whole}
          onWholeChange={setWhole}
          onMaximize={inDialog ? undefined : () => setMaximized(true)}
        />
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-3">
      <CodeFacts code={code} moduleFolder={moduleFolder} repository={repository} />
      {!maximized && browser(false)}
      <Dialog open={maximized} onOpenChange={setMaximized}>
        <DialogContent className="flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-3 p-4 sm:max-w-none">
          <DialogTitle className="pr-8 text-base">
            Code
            <span className="ml-2 font-mono text-sm font-normal text-muted-foreground">
              {code.kind === "repo"
                ? `${repository?.name ?? "repository"}: ${code.folder}`
                : "workspace"}
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            The code this block runs, full screen.
          </DialogDescription>
          {browser(true)}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** The picked file, as its changes or as a whole, with a note on files the code leaves alone. */
function ShownFile({
  file,
  base,
  whole,
  onWholeChange: setWhole,
  onMaximize,
}: {
  file: UnitFile
  base: string
  whole: boolean
  onWholeChange: (whole: boolean) => void
  /** Shows the code full screen; none when it already is. */
  onMaximize?: (() => void) | undefined
}) {
  const { didCopy, copy } = useCopyToClipboard(2000)
  const status = "status" in file ? (file as RepoFile).status : undefined
  const before = "before" in file ? (file as RepoFile).before : undefined
  const diff = before === undefined ? undefined : diffDiskContents(before, file.content)
  const note =
    status === "context"
      ? `Already on ${base}, shown for context. This code doesn't change it.`
      : status === "unchanged"
        ? `Already on ${base} as it is here.`
        : undefined

  const iconButton = "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"

  // The tree and the file share a top and a bottom; what's said about the file goes under it.
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {file.path}
          </span>
          {diff && (
            <div
              className="flex shrink-0 items-center gap-1 text-xs"
              role="group"
              aria-label="Show"
            >
              {[
                { label: "Changes", value: false },
                { label: "Whole file", value: true },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={whole === option.value}
                  onClick={() => setWhole(option.value)}
                  className={`whitespace-nowrap rounded px-2 py-0.5 font-medium ${
                    whole === option.value
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className={iconButton}
            aria-label={didCopy ? "Copied" : "Copy the file"}
            title={didCopy ? "Copied" : "Copy the file"}
            onClick={() => void copy(file.content)}
          >
            {didCopy ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
          {onMaximize && (
            <button
              type="button"
              className={iconButton}
              aria-label="Show the code full screen"
              title="Show the code full screen"
              onClick={onMaximize}
            >
              <Maximize2 className="size-3.5" />
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {diff && !whole ? (
            <DiffTable diffLines={diff} />
          ) : (
            <SyntaxHighlighter
              language={languageOf(file.path)}
              style={coy}
              showLineNumbers
              customStyle={{
                margin: 0,
                padding: "10px 0",
                fontSize: "12px",
                background: "transparent",
                border: "none",
                overflow: "visible",
              }}
              // The pane scrolls, so the code inside it doesn't scroll on its own.
              codeTagProps={{
                style: { overflow: "visible", display: "block", background: "transparent" },
              }}
              lineNumberStyle={PRISM_LINE_NUMBER_STYLE}
            >
              {file.content}
            </SyntaxHighlighter>
          )}
        </div>
      </div>
      {note && <p className="m-0 shrink-0 text-xs text-muted-foreground">{note}</p>}
    </>
  )
}
