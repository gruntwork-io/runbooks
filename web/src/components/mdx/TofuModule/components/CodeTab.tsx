import { useEffect, useMemo, useState } from "react"
import { Loader2, TriangleAlert } from "lucide-react"
import { useApi } from "@/contexts/ApiContext"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import { CodeFile } from "@/components/artifacts/code/CodeFile"
import { FileTree, type FileTreeNode } from "@/components/artifacts/code/FileTree"
import type { UnitFile } from "../../../../../../src/domain/tofu-module/unit"

/** How long the inputs must settle before the code renders again. */
const DEBOUNCE_MS = 300

interface CodeTabProps {
  blockId: string
  source: string
  /** The block's inputs as it publishes them. */
  values: Record<string, unknown>
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
      file: {
        name: parts.at(-1)!,
        path: file.path,
        content: file.content,
        language: languageOf(file.path),
        size: file.content.length,
      },
    })
  }
  return root
}

/**
 * The Terragrunt code the block runs: the module's template rendered with
 * the inputs as they are now, in a small file tree.
 */
export function CodeTab({ blockId, source, values, errorCount, selected, onSelect }: CodeTabProps) {
  const api = useApi()
  const [files, setFiles] = useState<UnitFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = JSON.stringify(values)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      api
        .invoke("tofu-module:render", { source, blockId, values: JSON.parse(key) })
        .then((result) => {
          if (cancelled) return
          setFiles(result.files)
          setError(null)
        })
        .catch((err: unknown) => {
          if (!cancelled)
            setError(cleanIpcErrorMessage(err instanceof Error ? err.message : String(err)))
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [api, source, blockId, key])

  const tree = useMemo(() => (files ? treeOf(files) : []), [files])
  const folders = useMemo(
    () => [
      ...new Set(
        (files ?? []).flatMap((f) => (f.path.includes("/") ? [f.path.split("/")[0]!] : [])),
      ),
    ],
    [files],
  )
  // The unit's own file, rather than the root.hcl beside it, unless the user picked one.
  const shown =
    files?.find((f) => f.path === selected) ??
    files?.find((f) => f.path.endsWith("/terragrunt.hcl")) ??
    files?.[0]

  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        {error}
      </div>
    )
  }
  if (!files || !shown) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Rendering the module's template…
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        The Terragrunt code that applies this module with your inputs. It changes as you edit them.
      </p>
      {errorCount > 0 && (
        <p className="flex items-center gap-1.5 text-sm text-warning-foreground">
          <TriangleAlert className="size-4" />
          {errorCount === 1 ? "1 input needs a fix" : `${errorCount} inputs need a fix`} on the UI
          tab, so this code isn't ready to apply.
        </p>
      )}
      <div className="flex flex-col gap-3 md:flex-row">
        <div className="shrink-0 rounded-md border border-border bg-card py-1 md:w-52">
          <FileTree
            items={tree}
            selectedId={shown.path}
            defaultExpandedIds={folders}
            onItemClick={(item) => {
              if (item.type === "file") onSelect(item.id)
            }}
          />
        </div>
        <div className="min-w-0 flex-1" data-testid="tofu-module-code">
          <CodeFile fileName={shown.path} code={shown.content} language={languageOf(shown.path)} />
        </div>
      </div>
    </div>
  )
}
