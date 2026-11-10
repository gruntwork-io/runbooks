import { useMemo, useState } from "react"
import { Loader2, TriangleAlert } from "lucide-react"
import { CodeFile } from "@/components/artifacts/code/CodeFile"
import { DiffTable } from "@/components/artifacts/code/DiffTable"
import {
  FileTree,
  type ChangeLabels,
  type FileTreeNode,
} from "@/components/artifacts/code/FileTree"
import { CodeFacts } from "./CodeFacts"
import { lineChanges, type FileChange } from "@/lib/fileReview"
import { diffDiskContents } from "@/lib/unifiedDiff"
import type { TofuModuleCode } from "../../../../../../electron/shared/channels"
import type { RepoFile, UnitFile } from "../../../../../../src/domain/tofu-module/unit"

interface CodeTabProps {
  code: TofuModuleCode | null
  /** The block's `source` prop, the module's folder. */
  moduleFolder: string
  error: string | null
  /** The repository the code goes to, as `owner/repo`, and the branch it's compared with. */
  repository?: { name: string; baseBranch: string } | undefined
  /** How many inputs need a fix, so the code may not be what applies. */
  errorCount: number
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
 * The Terragrunt code the block runs: the module's template rendered with
 * the inputs as they are now. With a repository, the unit sits in its folder
 * there, among the files above it that it may include; without one, it sits
 * in the block's workspace beside a root.hcl.
 */
export function CodeTab({
  code,
  moduleFolder,
  error,
  repository,
  errorCount,
  selected,
  onSelect,
}: CodeTabProps) {
  const files: readonly UnitFile[] = useMemo(() => code?.files ?? [], [code])
  const tree = useMemo(() => treeOf(files), [files])
  const folders = useMemo(() => foldersOf(files), [files])
  const changes = useMemo(
    () => (code?.kind === "repo" ? repoChanges(code.files) : undefined),
    [code],
  )
  // The unit's own file, rather than a file beside or above it, unless the user picked one.
  const shown =
    files.find((f) => f.path === selected) ??
    files.find((f) => f.path.endsWith("/terragrunt.hcl") && !isContext(f)) ??
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

  return (
    <div className="space-y-3">
      <CodeFacts code={code} moduleFolder={moduleFolder} repository={repository} />
      {errorCount > 0 && (
        <p className="flex items-center gap-1.5 text-sm text-warning-foreground">
          <TriangleAlert className="size-4" />
          {errorCount === 1 ? "1 input needs a fix" : `${errorCount} inputs need a fix`} on the UI
          tab, so this code isn't ready to apply.
        </p>
      )}
      <div className="flex flex-col gap-3 md:flex-row">
        <div className="flex shrink-0 flex-col rounded-md border border-border bg-card md:w-60">
          <div className="flex-1 overflow-x-auto py-1">
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
        <div className="min-w-0 flex-1" data-testid="tofu-module-code">
          <ShownFile file={shown} base={base} />
        </div>
      </div>
    </div>
  )
}

/** The picked file: a modified file as its changes or as a whole, and a note on files it leaves alone. */
function ShownFile({ file, base }: { file: UnitFile; base: string }) {
  const [whole, setWhole] = useState(false)
  const status = "status" in file ? (file as RepoFile).status : undefined
  const before = "before" in file ? (file as RepoFile).before : undefined
  const diff = useMemo(
    () => (before === undefined ? undefined : diffDiskContents(before, file.content)),
    [before, file.content],
  )
  const note =
    status === "context"
      ? `Already on ${base}, shown for context. This code doesn't change it.`
      : status === "unchanged"
        ? `Already on ${base} as it is here.`
        : undefined

  const toggle = diff && (
    <div className="flex items-center gap-1 text-xs" role="group" aria-label="Show">
      {[
        { label: "Changes", value: false },
        { label: "Whole file", value: true },
      ].map((option) => (
        <button
          key={option.label}
          type="button"
          aria-pressed={whole === option.value}
          onClick={() => setWhole(option.value)}
          className={`rounded px-2 py-0.5 font-medium ${
            whole === option.value
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )

  // The tree and the file start at the same height; what's said about the file goes under it.
  return (
    <div className="space-y-1.5">
      {diff && !whole ? (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
            <span className="truncate font-mono text-xs text-muted-foreground">{file.path}</span>
            {toggle}
          </div>
          <DiffTable diffLines={diff} />
        </div>
      ) : (
        <CodeFile fileName={file.path} code={file.content} language={languageOf(file.path)} />
      )}
      {diff && whole && <div className="flex justify-end">{toggle}</div>}
      {note && <p className="m-0 text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}
