/**
 * @fileoverview ChangedFilesView Component
 *
 * Displays file changes in a GitHub pull request style view.
 * Shows all changed files in a vertical list with collapsible file bars.
 */

import type React from "react"
import { useState, useMemo, useEffect, useRef, forwardRef } from "react"
import { useCollapsibleFileList } from "@/hooks/useCollapsibleFileList"
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FileCode,
  FileDiff,
  FilePlus,
  FileMinus,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { SHOW_MORE_INCREMENT } from "@/lib/fileListDisplay"
import { ShowMoreBanner } from "@/lib/ShowMoreBanner"
import { CollapsibleFileHeader } from "@/components/artifacts/CollapsibleFileHeader"
import { FILE_TREE_INDENT } from "@/components/artifacts/code/FileTree"
import { Loader2, Download } from "lucide-react"
import { useResizablePanel } from "@/hooks/useResizablePanel"
import { ResizeHandle } from "@/components/ui/ResizeHandle"
import type { WorkspaceFileChange } from "@/hooks/useGitFileChanges"
import type { FileReveal } from "@/contexts/WorkspaceRevealContext"
import { ChangeProportionBar } from "./ChangeProportionBar"
import { generateUnifiedDiff } from "@/lib/unifiedDiff"
import { DiffTable } from "@/components/artifacts/code/DiffTable"

type ChangeType = WorkspaceFileChange["changeType"]

/** Maps change types to their icon and color */
const changeTypeConfig: Record<string, { icon: LucideIcon; color: string }> = {
  added: { icon: FilePlus, color: "text-success" },
  deleted: { icon: FileMinus, color: "text-destructive" },
  modified: { icon: FileDiff, color: "text-muted-foreground" },
}

const defaultChangeConfig = { icon: FileDiff, color: "text-muted-foreground" }

/** File icon for a change type (FilePlus/FileDiff/FileMinus), in its color. */
/** Git's letter for a change type: A, M or D. */
const CHANGE_LETTERS: Record<ChangeType, string> = { added: "A", modified: "M", deleted: "D" }

const ChangeTypeIcon = ({ changeType }: { changeType: ChangeType }) => {
  const { icon: Icon, color } = changeTypeConfig[changeType] ?? defaultChangeConfig
  return <Icon className={cn("w-4 h-4 flex-shrink-0", color)} />
}

interface ChangedFilesViewProps {
  /** List of file changes from useGitFileChanges */
  changes: WorkspaceFileChange[]
  /** Whether there are too many changes to display */
  tooManyChanges?: boolean
  /** Total number of changes */
  totalChanges?: number
  /** Whether changes are still loading */
  isLoading?: boolean
  /** Callback to load the full diff for a truncated file */
  onLoadDiff?: (filePath: string) => Promise<void>
  /** Mark each file in the tree with git's letter for its change: A, M or D. */
  letters?: boolean
  /** Checkboxes in the tree to choose files, such as the ones to commit. */
  selection?: FileSelection
  /** Files a block asks to show: the first changed one is selected, and each flashes. */
  reveal?: Pick<FileReveal, "id" | "paths"> | null | undefined
  /** Additional CSS classes */
  className?: string
}

/** Which changed files are chosen, and how a checkbox changes that. */
export interface FileSelection {
  readonly isSelected: (path: string) => boolean
  /** Choose or drop these files, all of a folder's at once for its checkbox. */
  readonly setSelected: (paths: readonly string[], selected: boolean) => void
  /** While set, the checkboxes can't change. */
  readonly disabled?: boolean
}

/** How long revealed files stay highlighted, matching the flash animation. */
const FLASH_MS = 2400

export const ChangedFilesView = ({
  changes,
  tooManyChanges = false,
  totalChanges,
  isLoading = false,
  onLoadDiff,
  letters = false,
  selection,
  reveal,
  className = "",
}: ChangedFilesViewProps) => {
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(() => new Set())
  const { treeWidth, isResizing, containerRef, treeRef, handleMouseDown } = useResizablePanel()
  const {
    collapsedFiles,
    displayedItems: displayedChanges,
    hasMoreItems: hasMoreFiles,
    toggleCollapse: toggleFileCollapse,
    showMore: handleShowMore,
    expandAndJump,
    setItemRef: setFileRef,
  } = useCollapsibleFileList({
    items: changes,
    getKey: (c) => c.path,
    changeKey: changes.length,
  })

  const fileTree = useMemo(() => buildFileTree(changes), [changes])

  const handleFileSelect = (filePath: string) => {
    setFocusedPath(filePath)
    expandAndJump(
      filePath,
      changes.findIndex((c) => c.path === filePath),
    )
  }

  // Shows a block's files once they're among the changes, which can take a
  // refresh after the block writes them. Each request is shown once.
  const shownRevealId = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!reveal || shownRevealId.current === reveal.id) return
    const shown = reveal.paths.filter((p) => changes.some((c) => c.path === p))
    if (shown.length === 0) return
    // On the next frame, once the files' rows are drawn.
    const frame = requestAnimationFrame(() => {
      shownRevealId.current = reveal.id
      handleFileSelect(shown[0]!)
      setFlashing(new Set(shown))
    })
    return () => cancelAnimationFrame(frame)
    // Selects the file when the request or the changes do, not when the handler does.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, changes])
  useEffect(() => {
    if (flashing.size === 0) return
    const timer = setTimeout(() => setFlashing(new Set()), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flashing])

  // Loading state
  if (isLoading && changes.length === 0) {
    return (
      <div className={cn("flex items-center justify-center h-full", className)}>
        <div className="text-center">
          <Loader2 className="w-8 h-8 mx-auto mb-2 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Checking for changes...</p>
        </div>
      </div>
    )
  }

  // Too many changes
  if (tooManyChanges) {
    return (
      <div className={cn("flex items-center justify-center h-full", className)}>
        <div className="text-center">
          <FileCode className="w-16 h-16 mx-auto mb-2 text-warning" />
          <h3 className="text-lg font-medium mb-2 text-foreground">Too many changes to display</h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            {totalChanges ?? 0} files changed. This may be caused by a command that generated a
            large number of files (e.g.{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">npm install</code>).
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            Consider revising the runbook to reduce the number of changed files.
          </p>
        </div>
      </div>
    )
  }

  // Empty state
  if (changes.length === 0) {
    return (
      <div className={cn("flex items-center justify-center h-full", className)}>
        <div className="text-center">
          <FileCode className="w-16 h-16 mx-auto mb-2 text-muted-foreground" />
          <h3 className="text-lg font-medium mb-2 text-foreground">No changes detected</h3>
          <p className="text-sm text-muted-foreground">Modified files will appear here.</p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={cn("h-full flex flex-col", isResizing && "select-none", className)}
    >
      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* File Tree */}
        <div
          ref={treeRef}
          className="flex-shrink-0 overflow-y-auto"
          style={{ width: `${treeWidth}px` }}
        >
          <ChangedFileTree
            tree={fileTree}
            focusedPath={focusedPath}
            flashing={flashing}
            onFileSelect={handleFileSelect}
            letters={letters}
            {...(selection ? { selection } : {})}
          />
        </div>

        <ResizeHandle onMouseDown={handleMouseDown} />

        {/* All Files Diff View */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="flex flex-col gap-3">
            {displayedChanges.map((change) => (
              <CollapsibleFileDiff
                key={change.path}
                change={change}
                isCollapsed={collapsedFiles.has(change.path)}
                isFocused={focusedPath === change.path}
                isFlashing={flashing.has(change.path)}
                onToggleCollapse={() => toggleFileCollapse(change.path)}
                onLoadDiff={onLoadDiff}
                ref={(el) => setFileRef(change.path, el)}
              />
            ))}
            {/* Show more / truncation banner */}
            {hasMoreFiles && (
              <ShowMoreBanner
                displayedCount={displayedChanges.length}
                total={changes.length}
                remaining={Math.min(SHOW_MORE_INCREMENT, changes.length - displayedChanges.length)}
                noun="changed files"
                onShowMore={handleShowMore}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// File Tree Components
// ============================================================================

interface TreeNode {
  name: string
  path: string
  type: "file" | "folder"
  children?: TreeNode[]
  change?: WorkspaceFileChange
}

function buildFileTree(changes: WorkspaceFileChange[]): TreeNode[] {
  const root: TreeNode[] = []

  for (const change of changes) {
    // Strip trailing slashes (git may report directories as "docs/")
    const cleanPath = change.path.replace(/\/+$/, "")
    if (!cleanPath) continue // Skip empty paths
    const parts = cleanPath.split("/")
    let current = root
    let currentPath = ""

    for (const [i, part] of parts.entries()) {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const isFile = i === parts.length - 1

      let node = current.find((n) => n.name === part)

      if (!node) {
        node = isFile
          ? { name: part, path: currentPath, type: "file", change }
          : { name: part, path: currentPath, type: "folder", children: [] }
        current.push(node)
      }

      if (!isFile && node.children) {
        current = node.children
      }
    }
  }

  // Sort: folders first, then files, alphabetically
  const sortTree = (nodes: TreeNode[]): TreeNode[] => {
    return nodes
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map((node) => (node.children ? { ...node, children: sortTree(node.children) } : node))
  }

  return sortTree(root)
}

interface ChangedFileTreeProps {
  tree: TreeNode[]
  focusedPath: string | null
  /** Files to highlight for a moment, whose folders open. */
  flashing: ReadonlySet<string>
  onFileSelect: (filePath: string) => void
  letters: boolean
  selection?: FileSelection
}

/** Max tree nodes to render before collapsing all folders by default */
const MAX_TREE_NODES_EXPANDED = 200

const ChangedFileTree = ({
  tree,
  focusedPath,
  flashing,
  onFileSelect,
  letters,
  selection,
}: ChangedFileTreeProps) => {
  // For large trees, start with all folders collapsed to avoid rendering
  // thousands of nodes which can lock up the browser.
  const totalFileCount = useMemo(() => countTreeFiles(tree), [tree])
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() =>
    totalFileCount > MAX_TREE_NODES_EXPANDED ? new Set<string>() : new Set(getAllFolderPaths(tree)),
  )

  // A highlighted file's folders open, so it can be seen.
  const [prevFlashing, setPrevFlashing] = useState(flashing)
  if (flashing !== prevFlashing) {
    setPrevFlashing(flashing)
    const folders = [...flashing].flatMap(foldersOf).filter((f) => !expandedFolders.has(f))
    if (folders.length > 0) setExpandedFolders(new Set([...expandedFolders, ...folders]))
  }

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  // Indent per level (8 base + 11 = 19px for level 1). Shared with <FileTree>
  // so the two sibling trees stay visually aligned.
  const INDENT = FILE_TREE_INDENT

  const renderNode = (node: TreeNode, level: number = 0): React.ReactNode => {
    const isExpanded = expandedFolders.has(node.path)
    const isSelected = node.change?.path === focusedPath

    if (node.type === "folder") {
      const files = selection ? filePathsUnder(node) : []
      const chosen = files.filter((path) => selection?.isSelected(path)).length
      return (
        <div key={node.path}>
          <div
            className="flex items-center hover:bg-accent"
            style={{ paddingLeft: `${8 + level * INDENT}px` }}
          >
            {selection && (
              <SelectionBox
                label={`Choose every file in ${node.path}`}
                checked={chosen === files.length}
                indeterminate={chosen > 0 && chosen < files.length}
                disabled={selection.disabled}
                onChange={(next) => selection.setSelected(files, next)}
              />
            )}
            <button
              role="treeitem"
              onClick={() => toggleFolder(node.path)}
              className={cn(
                "w-full flex items-center gap-0.5 py-px text-left text-sm transition-colors cursor-pointer",
                "text-foreground",
              )}
            >
              {isExpanded ? (
                <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              )}
              {isExpanded ? (
                <FolderOpen className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              ) : (
                <Folder className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              )}
              <span className="truncate ml-1">{node.name}</span>
            </button>
          </div>
          {isExpanded && node.children && (
            <div>{node.children.map((child) => renderNode(child, level + 1))}</div>
          )}
        </div>
      )
    }

    // File node - spacer + change type icon (FilePlus/FileDiff/FileMinus)
    const change = node.change
    if (!change) return null

    return (
      <div
        key={node.path}
        className={cn(
          "flex items-center",
          isSelected ? "bg-info-muted text-primary" : "hover:bg-accent text-foreground",
          flashing.has(change.path) && "animate-reveal-flash",
        )}
        style={{ paddingLeft: `${8 + level * INDENT}px` }}
      >
        {selection && (
          <SelectionBox
            label={`Choose ${change.path}`}
            checked={selection.isSelected(change.path)}
            disabled={selection.disabled}
            onChange={(next) => selection.setSelected([change.path], next)}
          />
        )}
        <button
          role="treeitem"
          onClick={() => onFileSelect(change.path)}
          className="w-full flex items-center gap-0.5 py-px text-left text-sm transition-colors cursor-pointer"
        >
          {/* Spacer (same width as chevron) to align file icons with folder icons */}
          <span className="w-4 flex-shrink-0" />
          <ChangeTypeIcon changeType={change.changeType} />
          <span className="truncate flex-1 ml-1">{node.name}</span>
          {letters && (
            <span
              className={cn(
                "w-4 flex-shrink-0 pr-1 text-center font-mono text-xs font-semibold",
                (changeTypeConfig[change.changeType] ?? defaultChangeConfig).color,
              )}
              title={change.changeType}
            >
              {CHANGE_LETTERS[change.changeType]}
            </span>
          )}
        </button>
      </div>
    )
  }

  return <div className="py-1">{tree.map((node) => renderNode(node))}</div>
}

/** A checkbox in a tree row, mixed when a folder's files are partly chosen. */
const SelectionBox = ({
  label,
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
}: {
  label: string
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean | undefined
  onChange: (checked: boolean) => void
}) => (
  <input
    type="checkbox"
    aria-label={label}
    checked={checked}
    disabled={disabled}
    ref={(el) => {
      if (el) el.indeterminate = indeterminate
    }}
    onChange={(e) => onChange(e.target.checked)}
    className="size-3.5 mr-1 flex-shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
  />
)

/** The paths of every changed file under a folder. */
function filePathsUnder(node: TreeNode): string[] {
  if (node.type === "file") return node.change ? [node.change.path] : []
  return (node.children ?? []).flatMap(filePathsUnder)
}

/** The folders a path is in, outermost first: "a/b/c.txt" is in "a" and "a/b". */
function foldersOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1)
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"))
}

function countTreeFiles(nodes: TreeNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.type === "file") {
      count++
    }
    if (node.children) {
      count += countTreeFiles(node.children)
    }
  }
  return count
}

function getAllFolderPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = []
  const traverse = (levelNodes: TreeNode[]) => {
    for (const node of levelNodes) {
      if (node.type === "folder") {
        paths.push(node.path)
        if (node.children) traverse(node.children)
      }
    }
  }
  traverse(nodes)
  return paths
}

// ============================================================================
// Collapsible File Diff Component
// ============================================================================

interface CollapsibleFileDiffProps {
  change: WorkspaceFileChange
  isCollapsed: boolean
  isFocused: boolean
  /** Highlighted for a moment, as a block's file it just showed. */
  isFlashing: boolean
  onToggleCollapse: () => void
  onLoadDiff?: ((filePath: string) => Promise<void>) | undefined
}

const CollapsibleFileDiff = forwardRef<HTMLDivElement, CollapsibleFileDiffProps>(
  ({ change, isCollapsed, isFocused, isFlashing, onToggleCollapse, onLoadDiff }, ref) => {
    const [isLoadingDiff, setIsLoadingDiff] = useState(false)

    return (
      <div
        ref={ref}
        data-testid={`diff-file-${change.path}`}
        className={cn(
          "border border-border rounded-md overflow-hidden bg-card",
          isFocused && "ring-2 ring-ring",
          isFlashing && "animate-reveal-glow",
        )}
      >
        {/* File Header Bar */}
        <CollapsibleFileHeader
          isCollapsed={isCollapsed}
          onToggle={onToggleCollapse}
          path={change.path}
          icon={<ChangeTypeIcon changeType={change.changeType} />}
          trailing={
            <div className="flex items-center gap-2 text-xs flex-shrink-0">
              {change.additions > 0 && (
                <span className="text-success font-medium">+{change.additions}</span>
              )}
              {change.deletions > 0 && (
                <span className="text-destructive font-medium">-{change.deletions}</span>
              )}
              <ChangeProportionBar additions={change.additions} deletions={change.deletions} />
            </div>
          }
        />

        {/* Diff Content */}
        {!isCollapsed &&
          (change.isDirectory ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              Directory or embedded git repository — no inline diff to show.
            </div>
          ) : change.isBinary ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              Binary file — cannot display diff
            </div>
          ) : change.diffTruncated ? (
            <div className="p-4 text-center">
              <p className="text-sm text-muted-foreground mb-2">
                Diff is too large to display inline.
              </p>
              <button
                onClick={async () => {
                  if (onLoadDiff) {
                    setIsLoadingDiff(true)
                    try {
                      await onLoadDiff(change.path)
                    } finally {
                      setIsLoadingDiff(false)
                    }
                  }
                }}
                disabled={isLoadingDiff}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary/90 disabled:opacity-50 cursor-pointer"
              >
                {isLoadingDiff ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...
                  </>
                ) : (
                  <>
                    <Download className="w-3.5 h-3.5" /> Load diff
                  </>
                )}
              </button>
            </div>
          ) : (
            <>
              <SvgPreview change={change} />
              <DiffContent change={change} />
            </>
          ))}
      </div>
    )
  },
)
CollapsibleFileDiff.displayName = "CollapsibleFileDiff"

// ============================================================================
// SVG Preview Component
// ============================================================================

function isSvgFile(path: string): boolean {
  return path.toLowerCase().endsWith(".svg")
}

// Percent-encode rather than btoa(): btoa throws on any character above U+00FF
// and encodes U+0080-U+00FF as Latin-1 bytes, but the SVG is parsed as UTF-8.
function svgToDataUri(svgText: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`
}

const SvgPreview = ({ change }: { change: WorkspaceFileChange }) => {
  if (!isSvgFile(change.path)) return null

  const hasOriginal = !!change.originalContent
  const hasNew = !!change.newContent

  if (!hasOriginal && !hasNew) return null

  return (
    <div className="flex items-start gap-4 p-4 border-b border-border bg-muted/50">
      {hasOriginal && hasNew ? (
        <>
          <div className="flex-1 text-center">
            <span className="inline-block mb-2 text-xs font-medium text-destructive bg-destructive-muted border border-destructive/30 rounded px-2 py-0.5">
              Before
            </span>
            <div className="flex justify-center">
              <img
                src={svgToDataUri(change.originalContent!)}
                alt="Before"
                className="max-h-40 border border-border rounded bg-card p-2"
              />
            </div>
          </div>
          <div className="flex-1 text-center">
            <span className="inline-block mb-2 text-xs font-medium text-success bg-success-muted border border-success/30 rounded px-2 py-0.5">
              After
            </span>
            <div className="flex justify-center">
              <img
                src={svgToDataUri(change.newContent!)}
                alt="After"
                className="max-h-40 border border-border rounded bg-card p-2"
              />
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 text-center">
          <div className="flex justify-center">
            <img
              src={svgToDataUri((change.newContent || change.originalContent)!)}
              alt={change.path}
              className="max-h-40 border border-border rounded bg-card p-2"
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Diff Content Component
// ============================================================================

interface DiffContentProps {
  change: WorkspaceFileChange
}

const DiffContent = ({ change }: DiffContentProps) => {
  // Generate unified diff lines (undefined when a needed side is unavailable)
  const diffLines = useMemo(() => generateUnifiedDiff(change), [change])

  if (!diffLines) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        Diff unavailable for this file
      </div>
    )
  }

  if (diffLines.length === 0) {
    return <div className="p-4 text-center text-sm text-muted-foreground">Empty file</div>
  }

  return <DiffTable diffLines={diffLines} />
}
