/**
 * @fileoverview ChangedFilesView Component
 * 
 * Displays file changes in a GitHub pull request style view.
 * Shows unified diff with +/- prefixes, line numbers, and collapsible context.
 */

import { useState, useMemo } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FileCode,
  FileDiff,
  FilePlus,
  FileMinus,
  Check,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FileChange, FileChangeType } from '@/types/workspace'

/**
 * Returns the appropriate icon for a file change type
 */
function getChangeTypeIcon(changeType: FileChangeType): LucideIcon {
  switch (changeType) {
    case 'added':
      return FilePlus
    case 'modified':
      return FileDiff
    case 'deleted':
      return FileMinus
    case 'renamed':
      return FileDiff
    default:
      return FileDiff
  }
}

interface ChangedFilesViewProps {
  /** List of file changes */
  changes: FileChange[];
  /** Additional CSS classes */
  className?: string;
}

export const ChangedFilesView = ({
  changes,
  className = "",
}: ChangedFilesViewProps) => {
  const [selectedFileId, setSelectedFileId] = useState<string | null>(
    changes.length > 0 ? changes[0].id : null
  )
  const [treeWidth] = useState(280)
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set())
  
  // Build file tree from changes
  const fileTree = useMemo(() => buildFileTree(changes), [changes])
  
  // Get selected file
  const selectedFile = useMemo(
    () => changes.find(c => c.id === selectedFileId) || null,
    [changes, selectedFileId]
  )
  
  // Calculate totals
  const totalAdditions = changes.reduce((sum, c) => sum + c.additions, 0)
  const totalDeletions = changes.reduce((sum, c) => sum + c.deletions, 0)
  
  // Handle file selection
  const handleFileSelect = (fileId: string) => {
    setSelectedFileId(fileId)
    setViewedFiles(prev => new Set([...prev, fileId]))
  }
  
  // Empty state
  if (changes.length === 0) {
    return (
      <div className={cn("flex items-center justify-center h-full", className)}>
        <div className="text-center">
          <FileCode className="w-16 h-16 mx-auto mb-2 text-gray-300" />
          <h3 className="text-lg font-medium mb-2 text-gray-600">
            No changes
          </h3>
          <p className="text-sm text-gray-500">
            Modified files will appear here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("h-full flex flex-col", className)}>
      {/* Summary Header */}
      <div className="flex-shrink-0 px-4 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600">
            <span className="font-medium">{changes.length}</span> changed{' '}
            {changes.length === 1 ? 'file' : 'files'}
            <span className="mx-2 text-gray-300">|</span>
            <span className="font-medium">{viewedFiles.size}</span> / {changes.length} viewed
          </span>
          <div className="flex items-center gap-3">
            <span className="text-green-600 font-medium">+{totalAdditions}</span>
            <span className="text-red-600 font-medium">-{totalDeletions}</span>
          </div>
        </div>
      </div>
      
      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* File Tree */}
        <div 
          className="flex-shrink-0 border-r border-gray-200 overflow-y-auto bg-gray-50"
          style={{ width: `${treeWidth}px` }}
        >
          <ChangedFileTree
            tree={fileTree}
            changes={changes}
            selectedFileId={selectedFileId}
            viewedFiles={viewedFiles}
            onFileSelect={handleFileSelect}
          />
        </div>
        
        {/* Diff View */}
        <div className="flex-1 overflow-y-auto">
          {selectedFile ? (
            <UnifiedDiffView change={selectedFile} />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              Select a file to view changes
            </div>
          )}
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
  selectedFileId: string | null;
  viewedFiles: Set<string>;
  onFileSelect: (fileId: string) => void;
}

const ChangedFileTree = ({
  tree,
  changes,
  selectedFileId,
  viewedFiles,
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
    const isSelected = node.change?.id === selectedFileId
    const isViewed = node.change ? viewedFiles.has(node.change.id) : false
    
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
        {isViewed && (
          <Check className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
        )}
        <div className="flex items-center gap-1 text-xs flex-shrink-0 ml-1">
          {change.additions > 0 && (
            <span className="text-green-600">+{change.additions}</span>
          )}
          {change.deletions > 0 && (
            <span className="text-red-600">-{change.deletions}</span>
          )}
        </div>
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
// Unified Diff View
// ============================================================================

interface UnifiedDiffViewProps {
  change: FileChange;
}

interface DiffLine {
  type: 'context' | 'addition' | 'deletion' | 'hunk-header';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

const UnifiedDiffView = ({ change }: UnifiedDiffViewProps) => {
  const [collapsedHunks, setCollapsedHunks] = useState<Set<number>>(new Set())
  
  // Generate unified diff lines
  const diffLines = useMemo(() => generateUnifiedDiff(change), [change])
  
  // Find hunk boundaries for collapsing
  const hunks = useMemo(() => findHunks(diffLines), [diffLines])
  
  const toggleHunk = (hunkIndex: number) => {
    setCollapsedHunks(prev => {
      const next = new Set(prev)
      if (next.has(hunkIndex)) {
        next.delete(hunkIndex)
      } else {
        next.add(hunkIndex)
      }
      return next
    })
  }
  
  // Use change type icon (FilePlus/FileDiff/FileMinus)
  const Icon = getChangeTypeIcon(change.changeType)
  const iconColor = getIconColor(change.changeType)
  
  return (
    <div className="min-h-full">
      {/* File Header */}
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2 bg-gray-100 border-b border-gray-200">
        <Icon className={cn("w-4 h-4", iconColor)} />
        <span className="font-mono text-sm font-medium text-gray-700">
          {change.path}
        </span>
        <span className={cn(
          "px-2 py-0.5 text-xs rounded-full",
          getChangeTypeBadgeStyle(change.changeType)
        )}>
          {getChangeTypeLabel(change.changeType)}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-xs">
          {change.additions > 0 && (
            <span className="text-green-600 font-medium">+{change.additions}</span>
          )}
          {change.deletions > 0 && (
            <span className="text-red-600 font-medium">-{change.deletions}</span>
          )}
        </div>
      </div>
      
      {/* Diff Content */}
      <div className="font-mono text-xs">
        {hunks.map((hunk, hunkIndex) => {
          const isCollapsed = collapsedHunks.has(hunkIndex)
          const isContextOnly = hunk.lines.every(l => l.type === 'context')
          
          return (
            <div key={hunkIndex}>
              {/* Hunk Header / Collapse Toggle */}
              {hunk.header && (
                <button
                  onClick={() => toggleHunk(hunkIndex)}
                  className="w-full flex items-center gap-2 px-4 py-1 bg-blue-50 text-blue-700 hover:bg-blue-100 text-left border-y border-blue-200"
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                  <span>{hunk.header}</span>
                  {isContextOnly && (
                    <span className="text-blue-500 text-xs">
                      ({hunk.lines.length} unchanged lines)
                    </span>
                  )}
                </button>
              )}
              
              {/* Hunk Lines */}
              {!isCollapsed && (
                <table className="w-full border-collapse">
                  <tbody>
                    {hunk.lines.map((line, lineIndex) => (
                      <DiffLineRow key={`${hunkIndex}-${lineIndex}`} line={line} />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface DiffLineRowProps {
  line: DiffLine;
}

const DiffLineRow = ({ line }: DiffLineRowProps) => {
  const bgColor = line.type === 'addition' 
    ? 'bg-green-50' 
    : line.type === 'deletion' 
    ? 'bg-red-50' 
    : ''
  
  const prefix = line.type === 'addition' 
    ? '+' 
    : line.type === 'deletion' 
    ? '-' 
    : ' '
  
  const prefixColor = line.type === 'addition'
    ? 'text-green-600'
    : line.type === 'deletion'
    ? 'text-red-600'
    : 'text-gray-400'
  
  const lineNumBg = line.type === 'addition'
    ? 'bg-green-100'
    : line.type === 'deletion'
    ? 'bg-red-100'
    : 'bg-gray-50'
  
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
  
  // Create a map of old lines for quick lookup
  const oldLineSet = new Set(oldLines)
  const newLineSet = new Set(newLines)
  
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

interface Hunk {
  header?: string;
  lines: DiffLine[];
}

function findHunks(lines: DiffLine[]): Hunk[] {
  if (lines.length === 0) return []
  
  const hunks: Hunk[] = []
  const contextLines = 3 // Number of context lines to show around changes
  
  // Find ranges of changes
  const changeRanges: { start: number; end: number }[] = []
  let inChange = false
  let changeStart = 0
  
  for (let i = 0; i < lines.length; i++) {
    const isChange = lines[i].type !== 'context'
    if (isChange && !inChange) {
      changeStart = Math.max(0, i - contextLines)
      inChange = true
    } else if (!isChange && inChange) {
      // Check if we should extend the current range or end it
      const nextChangeIndex = lines.slice(i).findIndex(l => l.type !== 'context')
      if (nextChangeIndex !== -1 && nextChangeIndex <= contextLines * 2) {
        // Next change is close, keep extending
        continue
      }
      changeRanges.push({ start: changeStart, end: Math.min(lines.length - 1, i + contextLines - 1) })
      inChange = false
    }
  }
  
  if (inChange) {
    changeRanges.push({ start: changeStart, end: lines.length - 1 })
  }
  
  // If no changes, treat all as context
  if (changeRanges.length === 0) {
    const firstLine = lines[0]
    const lastLine = lines[lines.length - 1]
    hunks.push({
      header: `@@ -${firstLine.oldLineNum || 1},${lines.length} +${firstLine.newLineNum || 1},${lines.length} @@`,
      lines,
    })
    return hunks
  }
  
  // Create hunks from ranges
  let lastEnd = -1
  
  for (const range of changeRanges) {
    // Add collapsed context if there's a gap
    if (lastEnd !== -1 && range.start > lastEnd + 1) {
      const contextStartLine = lines[lastEnd + 1]
      const contextEndLine = lines[range.start - 1]
      const contextCount = range.start - lastEnd - 1
      hunks.push({
        header: `@@ ${contextCount} unchanged lines (${contextStartLine.oldLineNum || '?'}-${contextEndLine.oldLineNum || '?'}) @@`,
        lines: lines.slice(lastEnd + 1, range.start),
      })
    }
    
    // Add the change hunk
    const hunkLines = lines.slice(range.start, range.end + 1)
    const firstLine = hunkLines[0]
    const deletions = hunkLines.filter(l => l.type === 'deletion').length
    const additions = hunkLines.filter(l => l.type === 'addition').length
    const oldStart = firstLine.oldLineNum || 1
    const newStart = firstLine.newLineNum || 1
    
    hunks.push({
      header: `@@ -${oldStart},${hunkLines.length - additions} +${newStart},${hunkLines.length - deletions} @@`,
      lines: hunkLines,
    })
    
    lastEnd = range.end
  }
  
  // Add trailing context if any
  if (lastEnd < lines.length - 1) {
    const trailingLines = lines.slice(lastEnd + 1)
    const firstLine = trailingLines[0]
    hunks.push({
      header: `@@ ${trailingLines.length} unchanged lines @@`,
      lines: trailingLines,
    })
  }
  
  return hunks
}

// ============================================================================
// Helper Functions
// ============================================================================

function getIconColor(type: FileChangeType): string {
  switch (type) {
    case 'added':
      return 'text-green-600'
    case 'modified':
      return 'text-gray-600'
    case 'deleted':
      return 'text-red-600'
    case 'renamed':
      return 'text-gray-600'
    default:
      return 'text-gray-600'
  }
}

function getChangeTypeLabel(type: FileChangeType): string {
  switch (type) {
    case 'added':
      return 'Added'
    case 'modified':
      return 'Modified'
    case 'deleted':
      return 'Deleted'
    case 'renamed':
      return 'Renamed'
    default:
      return type
  }
}

function getChangeTypeBadgeStyle(type: FileChangeType): string {
  switch (type) {
    case 'added':
      return 'bg-green-100 text-green-700'
    case 'modified':
      return 'bg-amber-100 text-amber-700'
    case 'deleted':
      return 'bg-red-100 text-red-700'
    case 'renamed':
      return 'bg-blue-100 text-blue-700'
    default:
      return 'bg-gray-100 text-gray-700'
  }
}
