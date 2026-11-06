import { useState, useMemo, forwardRef, memo, type CSSProperties } from "react"
import { useCollapsibleFileList } from "@/hooks/useCollapsibleFileList"
import { useUserScrolls } from "@/hooks/useUserScrolls"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { coy } from "react-syntax-highlighter/dist/esm/styles/prism"
import { FileTree, type FileTreeNode } from "./FileTree"
import { FolderOpen, FileCode, AlertTriangle, Check } from "lucide-react"
import { cn, formatFileSize } from "@/lib/utils"
import { useResizablePanel } from "@/hooks/useResizablePanel"
import { ResizeHandle } from "@/components/ui/ResizeHandle"
import type { TruncationInfo } from "@/contexts/GeneratedFilesContext.types"
import { SHOW_MORE_INCREMENT } from "@/lib/fileListDisplay"
import { PRISM_LINE_NUMBER_STYLE } from "@/lib/prismStyles"
import { ShowMoreBanner } from "@/lib/ShowMoreBanner"
import { CollapsibleFileHeader } from "@/components/artifacts/CollapsibleFileHeader"
import { sameChange, scrolledPast, type FileChange } from "@/lib/fileReview"
import type { GeneratedFilesReviewContextType } from "@/contexts/GeneratedFilesContext.types"

interface CodeFileCollectionProps {
  data: FileTreeNode[]
  className?: string | undefined
  hideContent?: boolean | undefined
  /** Backend truncation metadata (heavy dir recommendation) */
  truncationInfo?: TruncationInfo | null | undefined
  /**
   * The files changed since the user reviewed them, which are highlighted,
   * and the selection that reviews them. Without it, nothing is highlighted.
   */
  review?: GeneratedFilesReviewContextType | undefined
}

export const CodeFileCollection = ({
  data,
  className = "",
  hideContent = false,
  truncationInfo,
  review,
}: CodeFileCollectionProps) => {
  const { treeWidth, isResizing, containerRef, treeRef, handleMouseDown } = useResizablePanel()
  const [focusedFileId, setFocusedFileId] = useState<string | null>(null)
  const [filesPane, setFilesPane] = useState<HTMLDivElement | null>(null)

  // Extract only file items (with content) from FileTreeNode
  const fileItems = useMemo(() => {
    const files: FileTreeNode[] = []

    const traverse = (items: FileTreeNode[]) => {
      items.forEach((item) => {
        if (item.type === "file" && item.file) {
          files.push(item)
        }
        if (item.children) {
          traverse(item.children)
        }
      })
    }

    traverse(data)
    return files
  }, [data])

  // Stable identity key: detect when a *different* set of files arrives,
  // even if the count stays the same. Passed as changeKey to the hook.
  const fileIdsKey = useMemo(() => fileItems.map((f) => f.id).join("\0"), [fileItems])

  const {
    collapsedFiles,
    displayedItems: displayedFiles,
    hasMoreItems: hasMoreFiles,
    toggleCollapse: toggleFileCollapse,
    showMore: handleShowMore,
    expandAndJump,
    itemElement: fileElement,
    setItemRef: setFileRef,
  } = useCollapsibleFileList({
    items: fileItems,
    getKey: (f) => f.id,
    changeKey: fileIdsKey,
  })

  // Scrolling down past a changed file's changes reviews it, so a large set
  // of changes doesn't take a Dismiss for each file. Files that are collapsed
  // or not shown aren't, since the user didn't see them.
  useUserScrolls(filesPane, (scroll) => {
    if (!filesPane || !review || review.changes.size === 0) return
    const top = filesPane.getBoundingClientRect().top - filesPane.scrollTop
    const ends = new Map<string, number>()
    for (const [path, change] of review.changes) {
      const file = collapsedFiles.has(path) ? undefined : fileElement(path)
      if (!file) continue
      const end =
        change.lastLine === undefined ? file : (lineElement(file, change.lastLine) ?? file)
      ends.set(path, end.getBoundingClientRect().bottom - top)
    }
    const past = scrolledPast(ends, scroll)
    if (past.length > 0) review.dismissFiles(past)
  })

  // CFC tree-click guard: only act on file nodes (not folders).
  // A changed file opens at its first change.
  const handleFileTreeClick = (item: FileTreeNode) => {
    if (item.type === "file" && item.file) {
      const firstLine = review?.changes.get(item.id)?.firstLine
      review?.selectFile(item.id)
      setFocusedFileId(item.id)
      expandAndJump(
        item.id,
        fileItems.findIndex((f) => f.id === item.id),
        firstLine === undefined ? undefined : (file) => lineElement(file, firstLine),
      )
    }
  }

  return (
    <div className={`w-full h-full flex flex-col ${className}`}>
      {/* Content - shows empty state or file tree with files */}
      {data.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-1">
          <div className="text-center">
            <FolderOpen
              className={`w-16 h-16 mx-auto mb-2 ${hideContent ? "invisible" : "text-muted-foreground"}`}
            />
            <h3
              className={`text-lg font-medium mb-2 ${hideContent ? "text-transparent" : "text-muted-foreground"}`}
            >
              Generated files will render here.
            </h3>
            <p className={`text-sm ${hideContent ? "text-transparent" : "text-muted-foreground"}`}>
              Once you fill out an input form on the left, generated files will appear here.
            </p>
          </div>
        </div>
      ) : (
        <div
          ref={containerRef}
          className={cn("flex-1 flex overflow-hidden", isResizing && "select-none")}
        >
          {/* File Tree */}
          <div
            ref={treeRef}
            className="flex-shrink-0 overflow-y-auto"
            style={{ width: `${treeWidth}px` }}
          >
            <FileTree
              items={data}
              onItemClick={handleFileTreeClick}
              selectedId={review?.selectedPath}
              changes={review?.changes}
              className="relative"
            />
          </div>

          <ResizeHandle onMouseDown={handleMouseDown} />

          {/* All Files View */}
          <div ref={setFilesPane} className="flex-1 overflow-y-auto p-3">
            <div className="flex flex-col gap-3">
              {/* Backend truncation banner */}
              {truncationInfo?.truncatedTree && (
                <div className="px-3 py-3 bg-warning-muted border border-warning/30 rounded-md">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-warning-foreground">
                      <p>
                        Too many files to display ({truncationInfo.totalFiles.toLocaleString()}{" "}
                        found). Only the first {fileItems.length.toLocaleString()} files are shown.
                      </p>
                      {truncationInfo.heavyDirs && truncationInfo.heavyDirs.length > 0 && (
                        <p className="mt-1.5">
                          {truncationInfo.heavyDirs.length === 1 ? (
                            <>
                              The{" "}
                              <code className="px-1 py-0.5 bg-warning-muted border border-warning/30 rounded text-xs font-mono">
                                {truncationInfo.heavyDirs[0]!.path}/
                              </code>{" "}
                              directory ({truncationInfo.heavyDirs[0]!.fileCount.toLocaleString()}{" "}
                              files) may be the cause.
                            </>
                          ) : (
                            <>
                              The following directories may be the cause:{" "}
                              {truncationInfo.heavyDirs.map((dir, i) => (
                                <span key={dir.path}>
                                  {i > 0 && ", "}
                                  <code className="px-1 py-0.5 bg-warning-muted border border-warning/30 rounded text-xs font-mono">
                                    {dir.path}/
                                  </code>{" "}
                                  ({dir.fileCount.toLocaleString()} files)
                                </span>
                              ))}
                            </>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {displayedFiles.map((fileItem) => (
                <CollapsibleCodeFile
                  key={fileItem.id}
                  fileItem={fileItem}
                  isCollapsed={collapsedFiles.has(fileItem.id)}
                  isFocused={focusedFileId === fileItem.id}
                  onToggleCollapse={() => toggleFileCollapse(fileItem.id)}
                  change={review?.changes.get(fileItem.id)}
                  onDismiss={() => review?.dismissFiles([fileItem.id])}
                  ref={(el) => setFileRef(fileItem.id, el)}
                />
              ))}
              {/* Show more / pagination banner */}
              {hasMoreFiles && (
                <ShowMoreBanner
                  displayedCount={displayedFiles.length}
                  total={fileItems.length}
                  remaining={Math.min(
                    SHOW_MORE_INCREMENT,
                    fileItems.length - displayedFiles.length,
                  )}
                  noun="generated files"
                  onShowMore={handleShowMore}
                />
              )}
            </div>
            {/* Room below the files while some are left to review, so the
                last of them can be scrolled past the top too: the pane's
                height, less its top padding. */}
            {review && review.changes.size > 0 && (
              <div aria-hidden="true" className="h-[calc(100%+0.75rem)]" />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Collapsible Code File Component
// ============================================================================

interface CollapsibleCodeFileProps {
  fileItem: FileTreeNode
  isCollapsed: boolean
  isFocused: boolean
  onToggleCollapse: () => void
  /** How the file changed since the user reviewed it, when it did */
  change?: FileChange | undefined
  /** Mark the file reviewed */
  onDismiss: () => void
}

const CollapsibleCodeFileImpl = forwardRef<HTMLDivElement, CollapsibleCodeFileProps>(
  ({ fileItem, isCollapsed, isFocused, onToggleCollapse, change, onDismiss }, ref) => {
    const filePath = fileItem.file?.path || fileItem.name
    const code = fileItem.file?.content || ""
    const language = fileItem.file?.language || "text"
    const isTruncated = fileItem.file?.isTruncated === true
    const lineCount = code ? code.split("\n").length : 0

    const fileSize = fileItem.file?.size ?? 0
    const fileSizeLabel = formatFileSize(fileSize)
    const showsLines =
      change !== undefined && (change.changedLines.size > 0 || change.removedBefore.size > 0)

    return (
      <div
        ref={ref}
        data-testid={`code-file-${filePath}`}
        data-change={change?.status}
        className={cn(
          "border rounded-md overflow-hidden bg-card",
          change === undefined
            ? "border-border"
            : change.status === "added"
              ? "border-success"
              : "border-warning",
          isFocused && "ring-2 ring-ring",
        )}
      >
        {/* File Header Bar */}
        <CollapsibleFileHeader
          isCollapsed={isCollapsed}
          onToggle={onToggleCollapse}
          path={filePath}
          icon={<FileCode className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
          trailing={
            <>
              {change && <ChangeSummary change={change} onDismiss={onDismiss} />}
              <span className="text-xs text-muted-foreground flex-shrink-0">
                {isTruncated ? fileSizeLabel : `${lineCount} ${lineCount === 1 ? "line" : "lines"}`}
              </span>
            </>
          }
        />

        {/* File Content */}
        {!isCollapsed &&
          (isTruncated ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              File too large to display inline ({fileSizeLabel}).
            </div>
          ) : (
            <SyntaxHighlighter
              language={language}
              style={coy}
              showLineNumbers={true}
              customStyle={{
                fontSize: "12px",
                margin: 0,
                borderRadius: 0,
                border: "none",
                padding: "14px 0px",
                overflowX: "auto",
              }}
              lineNumberStyle={
                showsLines && change
                  ? (lineNumber) => changedLineNumberStyle(change, lineNumber)
                  : PRISM_LINE_NUMBER_STYLE
              }
              // Each line its own element, so changed ones can be highlighted
              // and scrolled to. Only for those: it slows rendering down.
              wrapLines={showsLines}
              lineProps={
                showsLines && change
                  ? (lineNumber) => changedLineProps(change, lineNumber, lineCount)
                  : {}
              }
            >
              {code}
            </SyntaxHighlighter>
          ))}
      </div>
    )
  },
)
CollapsibleCodeFileImpl.displayName = "CollapsibleCodeFileImpl"

/**
 * Memoize on the props that actually affect render output. We deliberately
 * skip `onToggleCollapse` (an inline closure recreated each parent render —
 * its behavior is fully captured by `isCollapsed`) and the forwarded `ref`
 * callback. Without this, every parent re-render reruns the Prism
 * SyntaxHighlighter for every visible file, which dominates paint time
 * after a Template render.
 */
const CollapsibleCodeFile = memo(CollapsibleCodeFileImpl, (prev, next) => {
  if (prev.isCollapsed !== next.isCollapsed) return false
  if (prev.isFocused !== next.isFocused) return false
  // onDismiss, like onToggleCollapse, only ever acts on this file.
  if (!sameChange(prev.change, next.change)) return false
  const a = prev.fileItem
  const b = next.fileItem
  if (a === b) return true
  if (a.id !== b.id) return false
  if (a.name !== b.name) return false
  if (a.file?.content !== b.file?.content) return false
  if (a.file?.path !== b.file?.path) return false
  if (a.file?.language !== b.file?.language) return false
  if (a.file?.size !== b.file?.size) return false
  if (a.file?.isTruncated !== b.file?.isTruncated) return false
  return true
})
CollapsibleCodeFile.displayName = "CollapsibleCodeFile"

/** What a changed file's header says of the change, with a button that marks it reviewed. */
function ChangeSummary({ change, onDismiss }: { change: FileChange; onDismiss: () => void }) {
  return (
    <span className="flex items-center gap-2 text-xs flex-shrink-0">
      {change.status === "added" ? (
        <span className="font-medium text-success">Added</span>
      ) : (
        <span className="font-medium text-warning-foreground">
          Modified
          {(change.additions > 0 || change.deletions > 0) && (
            <>
              {" "}
              <span className="text-success">+{change.additions}</span>{" "}
              <span className="text-destructive">-{change.deletions}</span>
            </>
          )}
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onDismiss()
        }}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-background cursor-pointer"
        title="Mark as reviewed: stop highlighting this file's changes"
      >
        <Check className="w-3 h-3" />
        Dismiss
      </button>
    </span>
  )
}

// A tint rather than a surface color: the code keeps its light Prism theme
// whatever the app's theme is.
const CHANGED_LINE_BACKGROUND = "color-mix(in oklch, var(--success) 20%, transparent)"

/** The line number of a changed line stands out, like the line. */
function changedLineNumberStyle(change: FileChange, lineNumber: number): CSSProperties {
  return change.changedLines.has(lineNumber)
    ? { ...PRISM_LINE_NUMBER_STYLE, color: "#555", fontWeight: 600 }
    : PRISM_LINE_NUMBER_STYLE
}

/**
 * Props of line `lineNumber` (1-based) of a changed file's `lineCount`: a
 * changed line is highlighted, and a mark shows where lines were removed.
 */
function changedLineProps(
  change: FileChange,
  lineNumber: number,
  lineCount: number,
): { style: CSSProperties; "data-line": number } {
  const shadows: string[] = []
  const style: CSSProperties = { display: "block" }
  if (change.changedLines.has(lineNumber)) style.backgroundColor = CHANGED_LINE_BACKGROUND
  if (change.removedBefore.has(lineNumber)) {
    shadows.push("inset 0 2px 0 var(--destructive)")
  }
  // Lines removed from the end of a file without a final newline
  if (lineNumber === lineCount && change.removedBefore.has(lineNumber + 1)) {
    shadows.push("inset 0 -2px 0 var(--destructive)")
  }
  if (shadows.length > 0) style.boxShadow = shadows.join(", ")
  return { style, "data-line": lineNumber }
}

/** Line `line` (1-based) of a file's highlighted code, or its last line when it has fewer. */
function lineElement(file: HTMLDivElement, line: number): Element | null {
  const lines = file.querySelectorAll("[data-line]")
  return lines[Math.min(line, lines.length) - 1] ?? null
}
