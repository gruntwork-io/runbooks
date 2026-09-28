/**
 * @fileoverview ChangedFilesView Component
 * 
 * Displays file changes in a GitHub pull request style view.
 * Shows all changed files in a vertical list with collapsible file bars.
 */

import type React from 'react'
import { useState, useMemo, forwardRef } from 'react'
import { useCollapsibleFileList } from '@/hooks/useCollapsibleFileList'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FileCode,
  FileDiff,
  FilePlus,
  FileMinus,
  UnfoldVertical,
  ArrowUpToLine,
  ArrowDownToLine,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { SHOW_MORE_INCREMENT } from '@/lib/fileListDisplay'
import { ShowMoreBanner } from '@/lib/ShowMoreBanner'
import { CollapsibleFileHeader } from '@/components/artifacts/CollapsibleFileHeader'
import { FILE_TREE_INDENT } from '@/components/artifacts/code/FileTree'
import { Loader2, Download } from 'lucide-react'
import { useResizablePanel } from '@/hooks/useResizablePanel'
import { ResizeHandle } from '@/components/ui/ResizeHandle'
import type { WorkspaceFileChange } from '@/hooks/useGitFileChanges'
import { ChangeProportionBar } from './ChangeProportionBar'
import { buildDiffSections, generateUnifiedDiff, getExpandedLines, type DiffLine } from '@/lib/unifiedDiff'

type ChangeType = WorkspaceFileChange['changeType']

/** Maps change types to their icon and color */
const changeTypeConfig: Record<string, { icon: LucideIcon; color: string }> = {
  added:    { icon: FilePlus,  color: 'text-success' },
  deleted:  { icon: FileMinus, color: 'text-destructive' },
  modified: { icon: FileDiff,  color: 'text-muted-foreground' },
}

const defaultChangeConfig = { icon: FileDiff, color: 'text-muted-foreground' }

function getChangeTypeIcon(changeType: ChangeType): LucideIcon {
  return (changeTypeConfig[changeType] ?? defaultChangeConfig).icon
}


interface ChangedFilesViewProps {
  /** List of file changes from useGitFileChanges */
  changes: WorkspaceFileChange[];
  /** Whether there are too many changes to display */
  tooManyChanges?: boolean;
  /** Total number of changes */
  totalChanges?: number;
  /** Whether changes are still loading */
  isLoading?: boolean;
  /** Callback to load the full diff for a truncated file */
  onLoadDiff?: (filePath: string) => Promise<void>;
  /** Additional CSS classes */
  className?: string;
}

export const ChangedFilesView = ({
  changes,
  tooManyChanges = false,
  totalChanges,
  isLoading = false,
  onLoadDiff,
  className = "",
}: ChangedFilesViewProps) => {
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
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
    expandAndJump(filePath, changes.findIndex(c => c.path === filePath))
  }

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
          <h3 className="text-lg font-medium mb-2 text-foreground">
            Too many changes to display
          </h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            {totalChanges ?? 0} files changed. This may be caused by a command that
            generated a large number of files (e.g. <code className="text-xs bg-muted px-1 py-0.5 rounded">npm install</code>).
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
          <h3 className="text-lg font-medium mb-2 text-foreground">
            No changes detected
          </h3>
          <p className="text-sm text-muted-foreground">
            Modified files will appear here.
          </p>
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
            onFileSelect={handleFileSelect}
          />
        </div>

        <ResizeHandle onMouseDown={handleMouseDown} />

        {/* All Files Diff View */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="flex flex-col gap-3">
            {displayedChanges.map(change => (
              <CollapsibleFileDiff
                key={change.path}
                change={change}
                isCollapsed={collapsedFiles.has(change.path)}
                isFocused={focusedPath === change.path}
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
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: TreeNode[];
  change?: WorkspaceFileChange;
}

function buildFileTree(changes: WorkspaceFileChange[]): TreeNode[] {
  const root: TreeNode[] = []
  
  for (const change of changes) {
    // Strip trailing slashes (git may report directories as "docs/")
    const cleanPath = change.path.replace(/\/+$/, '')
    if (!cleanPath) continue // Skip empty paths
    const parts = cleanPath.split('/')
    let current = root
    let currentPath = ''
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const isFile = i === parts.length - 1
      
      let node = current.find(n => n.name === part)
      
      if (!node) {
        node = {
          name: part,
          path: currentPath,
          type: isFile ? 'file' : 'folder',
          children: isFile ? undefined : [],
          change: isFile ? change : undefined,
        }
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
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map(node => ({
        ...node,
        children: node.children ? sortTree(node.children) : undefined,
      }))
  }
  
  return sortTree(root)
}

interface ChangedFileTreeProps {
  tree: TreeNode[];
  focusedPath: string | null;
  onFileSelect: (filePath: string) => void;
}

/** Max tree nodes to render before collapsing all folders by default */
const MAX_TREE_NODES_EXPANDED = 200

const ChangedFileTree = ({
  tree,
  focusedPath,
  onFileSelect,
}: ChangedFileTreeProps) => {
  // For large trees, start with all folders collapsed to avoid rendering
  // thousands of nodes which can lock up the browser.
  const totalFileCount = useMemo(() => countTreeFiles(tree), [tree])
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() =>
    totalFileCount > MAX_TREE_NODES_EXPANDED
      ? new Set<string>()
      : new Set(getAllFolderPaths(tree))
  )

  const toggleFolder = (path: string) => {
    setExpandedFolders(prev => {
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

    if (node.type === 'folder') {
      return (
        <div key={node.path}>
          <button
            role="treeitem"
            onClick={() => toggleFolder(node.path)}
            className={cn(
              "w-full flex items-center gap-0.5 py-px text-left text-sm transition-colors cursor-pointer",
              "hover:bg-accent text-foreground"
            )}
            style={{ paddingLeft: `${8 + level * INDENT}px` }}
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
          {isExpanded && node.children && (
            <div>
              {node.children.map(child => renderNode(child, level + 1))}
            </div>
          )}
        </div>
      )
    }

    // File node - spacer + change type icon (FilePlus/FileDiff/FileMinus)
    const change = node.change
    if (!change) return null

    const Icon = getChangeTypeIcon(change.changeType)
    const iconColor = getIconColor(change.changeType)

    return (
      <button
        key={node.path}
        role="treeitem"
        onClick={() => onFileSelect(change.path)}
        className={cn(
          "w-full flex items-center gap-0.5 py-px text-left text-sm transition-colors cursor-pointer",
          isSelected ? "bg-info-muted text-primary" : "hover:bg-accent text-foreground"
        )}
        style={{ paddingLeft: `${8 + level * INDENT}px` }}
      >
        {/* Spacer (same width as chevron) to align file icons with folder icons */}
        <span className="w-4 flex-shrink-0" />
        <Icon className={cn("w-4 h-4 flex-shrink-0", iconColor)} />
        <span className="truncate flex-1 ml-1">{node.name}</span>
      </button>
    )
  }

  return (
    <div className="py-1">
      {tree.map(node => renderNode(node))}
    </div>
  )
}

function countTreeFiles(nodes: TreeNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.type === 'file') {
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
  const traverse = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.type === 'folder') {
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
  change: WorkspaceFileChange;
  isCollapsed: boolean;
  isFocused: boolean;
  onToggleCollapse: () => void;
  onLoadDiff?: (filePath: string) => Promise<void>;
}

const CollapsibleFileDiff = forwardRef<HTMLDivElement, CollapsibleFileDiffProps>(
  ({ change, isCollapsed, isFocused, onToggleCollapse, onLoadDiff }, ref) => {
    const [isLoadingDiff, setIsLoadingDiff] = useState(false)

    const Icon = getChangeTypeIcon(change.changeType)
    const iconColor = getIconColor(change.changeType)

    return (
      <div 
        ref={ref}
        data-testid={`diff-file-${change.path}`}
        className={cn(
          "border border-border rounded-md overflow-hidden bg-card",
          isFocused && "ring-2 ring-ring"
        )}
      >
        {/* File Header Bar */}
        <CollapsibleFileHeader
          isCollapsed={isCollapsed}
          onToggle={onToggleCollapse}
          path={change.path}
          icon={<Icon className={cn("w-4 h-4 flex-shrink-0", iconColor)} />}
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
        {!isCollapsed && (
          change.isDirectory ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              Directory or embedded git repository — no inline diff to show.
            </div>
          ) : change.isBinary ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              Binary file — cannot display diff
            </div>
          ) : change.diffTruncated ? (
            <div className="p-4 text-center">
              <p className="text-sm text-muted-foreground mb-2">Diff is too large to display inline.</p>
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
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</>
                ) : (
                  <><Download className="w-3.5 h-3.5" /> Load diff</>
                )}
              </button>
            </div>
          ) : (
            <>
              <SvgPreview change={change} />
              <DiffContent change={change} />
            </>
          )
        )}
      </div>
    )
  }
)
CollapsibleFileDiff.displayName = 'CollapsibleFileDiff'

// ============================================================================
// SVG Preview Component
// ============================================================================

function isSvgFile(path: string): boolean {
  return path.toLowerCase().endsWith('.svg')
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
            <span className="inline-block mb-2 text-xs font-medium text-destructive bg-destructive-muted border border-destructive/30 rounded px-2 py-0.5">Before</span>
            <div className="flex justify-center">
              <img src={svgToDataUri(change.originalContent!)} alt="Before" className="max-h-40 border border-border rounded bg-card p-2" />
            </div>
          </div>
          <div className="flex-1 text-center">
            <span className="inline-block mb-2 text-xs font-medium text-success bg-success-muted border border-success/30 rounded px-2 py-0.5">After</span>
            <div className="flex justify-center">
              <img src={svgToDataUri(change.newContent!)} alt="After" className="max-h-40 border border-border rounded bg-card p-2" />
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 text-center">
          <div className="flex justify-center">
            <img src={svgToDataUri((change.newContent || change.originalContent)!)} alt={change.path} className="max-h-40 border border-border rounded bg-card p-2" />
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
  change: WorkspaceFileChange;
}

const DiffContent = ({ change }: DiffContentProps) => {
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set())
  
  // Generate unified diff lines (undefined when a needed side is unavailable)
  const diffLines = useMemo(() => generateUnifiedDiff(change), [change])
  
  // Create sections with collapsed context
  const sections = useMemo(() => (diffLines ? buildDiffSections(diffLines) : []), [diffLines])
  
  const toggleSection = (index: number) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }
  
  if (!diffLines) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        Diff unavailable for this file
      </div>
    )
  }

  if (diffLines.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        Empty file
      </div>
    )
  }
  
  return (
    <div className="font-mono text-xs">
      <table className="w-full border-collapse">
        <tbody>
          {sections.map((section, sectionIndex) => {
            if (section.type === 'collapsed') {
              const isExpanded = expandedSections.has(sectionIndex)
              
              if (isExpanded) {
                // Show the expanded lines
                const expandedLines = getExpandedLines(diffLines, sections, sectionIndex)
                return expandedLines.map((line, lineIndex) => (
                  <DiffLineRow key={`${sectionIndex}-exp-${lineIndex}`} line={line} />
                ))
              }
              
              // Show the expand bar with position-aware icons
              const position = section.position || 'middle'
              const ExpandIcon = position === 'top' 
                ? ArrowUpToLine 
                : position === 'bottom' 
                ? ArrowDownToLine 
                : UnfoldVertical
              
              return (
                <tr key={`collapsed-${sectionIndex}`} className="bg-info-muted">
                  <td colSpan={4} className="py-0 px-0">
                    <button
                      onClick={() => toggleSection(sectionIndex)}
                      className="w-full flex items-center gap-2 py-1.5 px-3 text-muted-foreground hover:text-foreground hover:bg-info-muted cursor-pointer transition-colors"
                    >
                      <ExpandIcon className="w-4 h-4" />
                      <span className="text-xs font-medium">
                        Expand {section.collapsedCount} hidden lines
                      </span>
                    </button>
                  </td>
                </tr>
              )
            }
            
            // Regular lines section
            return section.lines?.map((line, lineIndex) => (
              <DiffLineRow key={`${sectionIndex}-${lineIndex}`} line={line} />
            ))
          })}
        </tbody>
      </table>
    </div>
  )
}


interface DiffLineRowProps {
  line: DiffLine;
}

const diffLineStyles: Record<string, { bg: string; prefix: string; prefixColor: string; lineNumBg: string }> = {
  addition: { bg: 'bg-success-muted', prefix: '+', prefixColor: 'text-success', lineNumBg: 'bg-success-muted' },
  deletion: { bg: 'bg-destructive-muted', prefix: '-', prefixColor: 'text-destructive', lineNumBg: 'bg-destructive-muted' },
  context:  { bg: '',            prefix: ' ', prefixColor: 'text-muted-foreground', lineNumBg: 'bg-muted' },
}

const DiffLineRow = ({ line }: DiffLineRowProps) => {
  const { bg: bgColor, prefix, prefixColor, lineNumBg } = diffLineStyles[line.type] ?? diffLineStyles.context
  
  return (
    <tr className={bgColor}>
      {/* Old line number */}
      <td className={cn(
        "w-12 px-2 py-0 text-right text-muted-foreground select-none border-r border-border",
        lineNumBg
      )}>
        {line.type !== 'addition' ? line.oldLineNum : ''}
      </td>
      {/* New line number */}
      <td className={cn(
        "w-12 px-2 py-0 text-right text-muted-foreground select-none border-r border-border",
        lineNumBg
      )}>
        {line.type !== 'deletion' ? line.newLineNum : ''}
      </td>
      {/* Prefix (+/-/space) */}
      <td className={cn("w-6 px-1 py-0 text-center select-none font-bold", prefixColor)}>
        {prefix}
      </td>
      {/* Content */}
      <td className="px-2 py-0 whitespace-pre">
        <code className={cn(
          line.type === 'addition' && 'text-success',
          line.type === 'deletion' && 'text-destructive'
        )}>
          {line.content}
        </code>
      </td>
    </tr>
  )
}

// ============================================================================
// Helper Functions
// ============================================================================

function getIconColor(type: ChangeType): string {
  return (changeTypeConfig[type] ?? defaultChangeConfig).color
}

