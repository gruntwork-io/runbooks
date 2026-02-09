/**
 * @fileoverview ChangedFilesView Component
 * 
 * Displays file changes in a GitHub pull request style view.
 * Shows all changed files in a vertical list with collapsible file bars.
 */

import type React from 'react'
import { useState, useMemo, useCallback, useRef, forwardRef } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FileCode,
  FileDiff,
  FilePlus,
  FileMinus,
  Copy,
  Check,
  UnfoldVertical,
  ArrowUpToLine,
  ArrowDownToLine,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { Loader2, Download } from 'lucide-react'
import { useResizablePanel } from '@/hooks/useResizablePanel'
import type { FileChange, FileChangeType } from '@/types/workspace'
import type { WorkspaceFileChange } from '@/hooks/useWorkspaceChanges'

/** Maps change types to their icon and color */
const changeTypeConfig: Record<string, { icon: LucideIcon; color: string }> = {
  added:    { icon: FilePlus,  color: 'text-green-600' },
  deleted:  { icon: FileMinus, color: 'text-red-600' },
  modified: { icon: FileDiff,  color: 'text-gray-600' },
  renamed:  { icon: FileDiff,  color: 'text-gray-600' },
}

const defaultChangeConfig = { icon: FileDiff, color: 'text-gray-600' }

function getChangeTypeIcon(changeType: FileChangeType): LucideIcon {
  return (changeTypeConfig[changeType] ?? defaultChangeConfig).icon
}

/**
 * GitHub-style proportion bar showing additions vs deletions
 */
function ChangeProportionBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  const BOXES = 5

  if (total === 0) {
    return (
      <div className="flex items-center gap-0.5">
        {Array.from({ length: BOXES }).map((_, i) => (
          <div key={`n-${i}`} className="w-2 h-2 rounded-sm bg-gray-300" />
        ))}
      </div>
    )
  }

  let greenBoxes = Math.round((additions / total) * BOXES)
  if (additions > 0 && greenBoxes === 0) greenBoxes = 1
  if (deletions > 0 && greenBoxes === BOXES) greenBoxes = BOXES - 1
  
  const redBoxes = BOXES - greenBoxes
  
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: greenBoxes }).map((_, i) => (
        <div key={`g-${i}`} className="w-2 h-2 rounded-sm bg-green-500" />
      ))}
      {Array.from({ length: redBoxes }).map((_, i) => (
        <div key={`r-${i}`} className="w-2 h-2 rounded-sm bg-red-500" />
      ))}
    </div>
  )
}

interface ChangedFilesViewProps {
  /** List of file changes (from useWorkspaceChanges or legacy FileChange) */
  changes: (FileChange | WorkspaceFileChange)[];
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
  const [focusedFileId, setFocusedFileId] = useState<string | null>(null)
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const { treeWidth, isResizing, containerRef, treeRef, handleMouseDown } = useResizablePanel()
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  
  // Normalize changes to always have an id (WorkspaceFileChange uses path as id)
  const normalizedChanges: FileChange[] = useMemo(() => 
    changes.map(c => ({
      id: 'id' in c ? (c as FileChange).id : c.path,
      path: c.path,
      changeType: c.changeType as FileChangeType,
      additions: c.additions,
      deletions: c.deletions,
      originalContent: c.originalContent,
      newContent: c.newContent,
      language: c.language,
      originalPath: 'originalPath' in c ? (c as FileChange).originalPath : undefined,
      // Carry through extra fields
      ...('diffTruncated' in c ? { diffTruncated: (c as WorkspaceFileChange).diffTruncated } : {}),
      ...('isBinary' in c ? { isBinary: (c as WorkspaceFileChange).isBinary } : {}),
    }))
  , [changes])

  // Build file tree from changes
  const fileTree = useMemo(() => buildFileTree(normalizedChanges), [normalizedChanges])
  
  // Handle file selection from tree - jump to file
  const handleFileSelect = (fileId: string) => {
    setFocusedFileId(fileId)
    // Expand the file if it's collapsed
    setCollapsedFiles(prev => {
      const next = new Set(prev)
      next.delete(fileId)
      return next
    })
    // Jump to the file
    const fileEl = fileRefs.current.get(fileId)
    if (fileEl) {
      fileEl.scrollIntoView({ behavior: 'auto', block: 'start' })
    }
  }
  
  // Toggle file collapse
  const toggleFileCollapse = (fileId: string) => {
    setCollapsedFiles(prev => {
      const next = new Set(prev)
      if (next.has(fileId)) {
        next.delete(fileId)
      } else {
        next.add(fileId)
      }
      return next
    })
  }
  
  // Register file ref
  const setFileRef = useCallback((fileId: string, el: HTMLDivElement | null) => {
    if (el) {
      fileRefs.current.set(fileId, el)
    } else {
      fileRefs.current.delete(fileId)
    }
  }, [])
  
  // Loading state
  if (isLoading && changes.length === 0) {
    return (
      <div className={cn("flex items-center justify-center h-full", className)}>
        <div className="text-center">
          <Loader2 className="w-8 h-8 mx-auto mb-2 text-blue-500 animate-spin" />
          <p className="text-sm text-gray-500">Checking for changes...</p>
        </div>
      </div>
    )
  }

  // Too many changes
  if (tooManyChanges) {
    return (
      <div className={cn("flex items-center justify-center h-full", className)}>
        <div className="text-center">
          <FileCode className="w-16 h-16 mx-auto mb-2 text-amber-300" />
          <h3 className="text-lg font-medium mb-2 text-gray-600">
            Too many changes
          </h3>
          <p className="text-sm text-gray-500">
            {totalChanges ?? 0} files changed — too many to display.
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
          <FileCode className="w-16 h-16 mx-auto mb-2 text-gray-300" />
          <h3 className="text-lg font-medium mb-2 text-gray-600">
            No changes detected
          </h3>
          <p className="text-sm text-gray-500">
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
            changes={normalizedChanges}
            focusedFileId={focusedFileId}
            onFileSelect={handleFileSelect}
          />
        </div>
        
        {/* Resize Handle - 7px hit area with 1px visible line */}
        <div
          className="w-[7px] cursor-col-resize flex-shrink-0 flex items-stretch justify-center group"
          onMouseDown={handleMouseDown}
        >
          <div className="w-px bg-gray-300 group-hover:bg-blue-500 group-hover:shadow-[0_0_0_2px_rgba(59,130,246,0.5)] transition-all" />
        </div>
        
        {/* All Files Diff View */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="flex flex-col gap-3">
            {normalizedChanges.map(change => (
              <CollapsibleFileDiff
                key={change.id}
                change={change}
                isCollapsed={collapsedFiles.has(change.id)}
                isFocused={focusedFileId === change.id}
                onToggleCollapse={() => toggleFileCollapse(change.id)}
                onLoadDiff={onLoadDiff}
                ref={(el) => setFileRef(change.id, el)}
              />
            ))}
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
  change?: FileChange;
}

function buildFileTree(changes: FileChange[]): TreeNode[] {
  const root: TreeNode[] = []
  
  for (const change of changes) {
    const parts = change.path.split('/')
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
  changes: FileChange[];
  focusedFileId: string | null;
  onFileSelect: (fileId: string) => void;
}

const ChangedFileTree = ({
  tree,
  changes: _changes,
  focusedFileId,
  onFileSelect,
}: ChangedFileTreeProps) => {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(getAllFolderPaths(tree))
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
  
  // Indent per level (8 base + 11 = 19px for level 1)
  const INDENT = 11
  
  const renderNode = (node: TreeNode, level: number = 0): React.ReactNode => {
    const isExpanded = expandedFolders.has(node.path)
    const isSelected = node.change?.id === focusedFileId
    
    if (node.type === 'folder') {
      return (
        <div key={node.path}>
          <button
            role="treeitem"
            onClick={() => toggleFolder(node.path)}
            className={cn(
              "w-full flex items-center gap-0.5 py-px text-left text-sm transition-colors cursor-pointer",
              "hover:bg-gray-100 text-gray-700"
            )}
            style={{ paddingLeft: `${8 + level * INDENT}px` }}
          >
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
            ) : (
              <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
            )}
            {isExpanded ? (
              <FolderOpen className="w-4 h-4 text-gray-500 flex-shrink-0" />
            ) : (
              <Folder className="w-4 h-4 text-gray-500 flex-shrink-0" />
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
        onClick={() => onFileSelect(change.id)}
        className={cn(
          "w-full flex items-center gap-0.5 py-px text-left text-sm transition-colors cursor-pointer",
          isSelected ? "bg-blue-50 text-blue-700" : "hover:bg-gray-100 text-gray-700"
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
  change: FileChange & { diffTruncated?: boolean; isBinary?: boolean };
  isCollapsed: boolean;
  isFocused: boolean;
  onToggleCollapse: () => void;
  onLoadDiff?: (filePath: string) => Promise<void>;
}

const CollapsibleFileDiff = forwardRef<HTMLDivElement, CollapsibleFileDiffProps>(
  ({ change, isCollapsed, isFocused, onToggleCollapse, onLoadDiff }, ref) => {
    const { didCopy, copy } = useCopyToClipboard()
    const [isLoadingDiff, setIsLoadingDiff] = useState(false)

    const Icon = getChangeTypeIcon(change.changeType)
    const iconColor = getIconColor(change.changeType)

    const handleCopyPath = () => copy(change.path)
    
    return (
      <div 
        ref={ref}
        className={cn(
          "border border-gray-300 rounded-md overflow-hidden bg-white",
          isFocused && "ring-2 ring-blue-500"
        )}
      >
        {/* File Header Bar */}
        <div
          onClick={onToggleCollapse}
          className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 text-left cursor-pointer border-b border-gray-200"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleCollapse() }}
        >
          {isCollapsed ? (
            <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
          )}
          <Icon className={cn("w-4 h-4 flex-shrink-0", iconColor)} />
          <span className="font-mono text-xs text-gray-700 truncate">
            {change.path}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); handleCopyPath() }}
            className="p-0.5 text-gray-400 hover:text-gray-600 rounded flex-shrink-0"
            title="Copy file path"
          >
            {didCopy ? (
              <Check className="w-3.5 h-3.5 text-green-600" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
          <div className="flex-1" />
          <div className="flex items-center gap-2 text-xs flex-shrink-0">
            {change.additions > 0 && (
              <span className="text-green-600 font-medium">+{change.additions}</span>
            )}
            {change.deletions > 0 && (
              <span className="text-red-600 font-medium">-{change.deletions}</span>
            )}
            <ChangeProportionBar additions={change.additions} deletions={change.deletions} />
          </div>
        </div>
        
        {/* Diff Content */}
        {!isCollapsed && (
          change.isBinary ? (
            <div className="p-4 text-center text-sm text-gray-500">
              Binary file — cannot display diff
            </div>
          ) : change.diffTruncated ? (
            <div className="p-4 text-center">
              <p className="text-sm text-gray-500 mb-2">Diff is too large to display inline.</p>
              <button
                onClick={async () => {
                  if (onLoadDiff) {
                    setIsLoadingDiff(true)
                    await onLoadDiff(change.path)
                    setIsLoadingDiff(false)
                  }
                }}
                disabled={isLoadingDiff}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50 cursor-pointer"
              >
                {isLoadingDiff ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</>
                ) : (
                  <><Download className="w-3.5 h-3.5" /> Load diff</>
                )}
              </button>
            </div>
          ) : (
            <DiffContent change={change} />
          )
        )}
      </div>
    )
  }
)
CollapsibleFileDiff.displayName = 'CollapsibleFileDiff'

// ============================================================================
// Diff Content Component
// ============================================================================

interface DiffContentProps {
  change: FileChange;
}

interface DiffLine {
  type: 'context' | 'addition' | 'deletion' | 'hunk-header';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

interface DiffSection {
  type: 'lines' | 'collapsed';
  lines?: DiffLine[];
  collapsedCount?: number;
  startOldLine?: number;
  startNewLine?: number;
  position?: 'top' | 'middle' | 'bottom'; // For collapsed sections
}

const DiffContent = ({ change }: DiffContentProps) => {
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set())
  
  // Generate unified diff lines
  const diffLines = useMemo(() => generateUnifiedDiff(change), [change])
  
  // Create sections with collapsed context
  const sections = useMemo(() => {
    const result: DiffSection[] = []
    const contextSize = 3
    
    // Find all change indices
    const changeIndices: number[] = []
    diffLines.forEach((line, i) => {
      if (line.type !== 'context') {
        changeIndices.push(i)
      }
    })
    
    if (changeIndices.length === 0) {
      // No changes - collapse entire file (reaches both beginning and end)
      if (diffLines.length > 0) {
        result.push({
          type: 'collapsed',
          collapsedCount: diffLines.length,
          startOldLine: diffLines[0].oldLineNum,
          startNewLine: diffLines[0].newLineNum,
          position: 'top', // Starts at beginning, use ArrowUpToLine
        })
      }
      return result
    }
    
    let currentPos = 0
    
    for (let i = 0; i < changeIndices.length; i++) {
      const changeStart = changeIndices[i]
      
      // Find the end of this change block (consecutive changes)
      let changeEnd = changeStart
      while (i + 1 < changeIndices.length && changeIndices[i + 1] <= changeEnd + contextSize * 2 + 1) {
        i++
        changeEnd = changeIndices[i]
      }
      
      const contextStart = Math.max(currentPos, changeStart - contextSize)
      const contextEnd = Math.min(diffLines.length - 1, changeEnd + contextSize)
      
      // Add collapsed section before this change (if there's a gap)
      if (contextStart > currentPos) {
        const collapsedLines = diffLines.slice(currentPos, contextStart)
        if (collapsedLines.length > 0) {
          // Determine position based on whether it reaches beginning of file
          const startsAtBeginning = currentPos === 0
          
          result.push({
            type: 'collapsed',
            collapsedCount: collapsedLines.length,
            startOldLine: collapsedLines[0].oldLineNum,
            startNewLine: collapsedLines[0].newLineNum,
            position: startsAtBeginning ? 'top' : 'middle',
          })
        }
      }
      
      // Add the visible lines (context + changes)
      result.push({
        type: 'lines',
        lines: diffLines.slice(contextStart, contextEnd + 1),
      })
      
      currentPos = contextEnd + 1
    }
    
    // Add trailing collapsed section if needed
    if (currentPos < diffLines.length) {
      const collapsedLines = diffLines.slice(currentPos)
      // This section reaches the end of the file
      result.push({
        type: 'collapsed',
        collapsedCount: collapsedLines.length,
        startOldLine: collapsedLines[0].oldLineNum,
        startNewLine: collapsedLines[0].newLineNum,
        position: 'bottom',
      })
    }
    
    return result
  }, [diffLines])
  
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
  
  // Get the full lines for an expanded section
  const getExpandedLines = (sectionIndex: number): DiffLine[] => {
    // Find the section boundaries in diffLines
    let lineStart = 0
    for (let i = 0; i < sectionIndex; i++) {
      const section = sections[i]
      if (section.type === 'lines') {
        lineStart += section.lines?.length || 0
      } else {
        lineStart += section.collapsedCount || 0
      }
    }
    const section = sections[sectionIndex]
    return diffLines.slice(lineStart, lineStart + (section.collapsedCount || 0))
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
                const expandedLines = getExpandedLines(sectionIndex)
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
                <tr key={`collapsed-${sectionIndex}`} className="bg-blue-50">
                  <td colSpan={4} className="py-0 px-0">
                    <button
                      onClick={() => toggleSection(sectionIndex)}
                      className="w-full flex items-center gap-2 py-1.5 px-3 text-gray-400 hover:text-gray-500 hover:bg-blue-100 cursor-pointer transition-colors"
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
  addition: { bg: 'bg-green-50', prefix: '+', prefixColor: 'text-green-600', lineNumBg: 'bg-green-100' },
  deletion: { bg: 'bg-red-50',   prefix: '-', prefixColor: 'text-red-600',   lineNumBg: 'bg-red-100' },
  context:  { bg: '',            prefix: ' ', prefixColor: 'text-gray-400',  lineNumBg: 'bg-gray-50' },
}

const DiffLineRow = ({ line }: DiffLineRowProps) => {
  const { bg: bgColor, prefix, prefixColor, lineNumBg } = diffLineStyles[line.type] ?? diffLineStyles.context
  
  return (
    <tr className={bgColor}>
      {/* Old line number */}
      <td className={cn(
        "w-12 px-2 py-0 text-right text-gray-400 select-none border-r border-gray-200",
        lineNumBg
      )}>
        {line.type !== 'addition' ? line.oldLineNum : ''}
      </td>
      {/* New line number */}
      <td className={cn(
        "w-12 px-2 py-0 text-right text-gray-400 select-none border-r border-gray-200",
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
          line.type === 'addition' && 'text-green-800',
          line.type === 'deletion' && 'text-red-800'
        )}>
          {line.content}
        </code>
      </td>
    </tr>
  )
}

// ============================================================================
// Diff Generation
// ============================================================================

function generateUnifiedDiff(change: FileChange): DiffLine[] {
  const lines: DiffLine[] = []
  
  if (change.changeType === 'added' && change.newContent) {
    // All lines are additions
    const newLines = change.newContent.split('\n')
    newLines.forEach((content, i) => {
      lines.push({
        type: 'addition',
        content,
        newLineNum: i + 1,
      })
    })
  } else if (change.changeType === 'deleted' && change.originalContent) {
    // All lines are deletions
    const oldLines = change.originalContent.split('\n')
    oldLines.forEach((content, i) => {
      lines.push({
        type: 'deletion',
        content,
        oldLineNum: i + 1,
      })
    })
  } else if ((change.changeType === 'modified' || change.changeType === 'renamed') && 
             change.originalContent && change.newContent) {
    // Generate a simple unified diff
    const oldLines = change.originalContent.split('\n')
    const newLines = change.newContent.split('\n')
    
    // Use a simple LCS-based diff algorithm
    const diffResult = computeSimpleDiff(oldLines, newLines)
    
    let oldLineNum = 1
    let newLineNum = 1
    
    for (const item of diffResult) {
      if (item.type === 'equal') {
        lines.push({
          type: 'context',
          content: item.value,
          oldLineNum: oldLineNum++,
          newLineNum: newLineNum++,
        })
      } else if (item.type === 'delete') {
        lines.push({
          type: 'deletion',
          content: item.value,
          oldLineNum: oldLineNum++,
        })
      } else if (item.type === 'insert') {
        lines.push({
          type: 'addition',
          content: item.value,
          newLineNum: newLineNum++,
        })
      }
    }
  }
  
  return lines
}

interface DiffItem {
  type: 'equal' | 'delete' | 'insert';
  value: string;
}

function computeSimpleDiff(oldLines: string[], newLines: string[]): DiffItem[] {
  // Simple Myers diff algorithm approximation
  const result: DiffItem[] = []
  
  let oldIndex = 0
  let newIndex = 0
  
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex >= oldLines.length) {
      // Remaining new lines are insertions
      result.push({ type: 'insert', value: newLines[newIndex] })
      newIndex++
    } else if (newIndex >= newLines.length) {
      // Remaining old lines are deletions
      result.push({ type: 'delete', value: oldLines[oldIndex] })
      oldIndex++
    } else if (oldLines[oldIndex] === newLines[newIndex]) {
      // Lines match
      result.push({ type: 'equal', value: oldLines[oldIndex] })
      oldIndex++
      newIndex++
    } else {
      // Lines differ - check if old line appears later in new
      const oldLineInNew = newLines.slice(newIndex + 1).indexOf(oldLines[oldIndex])
      const newLineInOld = oldLines.slice(oldIndex + 1).indexOf(newLines[newIndex])
      
      if (oldLineInNew !== -1 && (newLineInOld === -1 || oldLineInNew <= newLineInOld)) {
        // Old line appears later in new - insert new lines until we reach it
        result.push({ type: 'insert', value: newLines[newIndex] })
        newIndex++
      } else if (newLineInOld !== -1) {
        // New line appears later in old - delete old lines until we reach it
        result.push({ type: 'delete', value: oldLines[oldIndex] })
        oldIndex++
      } else {
        // Neither line appears in the other - delete then insert
        result.push({ type: 'delete', value: oldLines[oldIndex] })
        oldIndex++
      }
    }
  }
  
  return result
}

// ============================================================================
// Helper Functions
// ============================================================================

function getIconColor(type: FileChangeType): string {
  return (changeTypeConfig[type] ?? defaultChangeConfig).color
}

