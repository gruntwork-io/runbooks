/**
 * @fileoverview FilesWorkspace Component
 * 
 * Main container for the files workspace with tabs for Generated, All, and Changed files.
 * Includes a metadata bar showing git info and workspace statistics.
 */

import { useState, useMemo } from 'react'
import { ChevronLeft, Folder, Copy, Check } from 'lucide-react'
import { cn, copyTextToClipboard } from '@/lib/utils'
import { WorkspaceTabBar } from './WorkspaceTabBar'
import { WorkspaceMetadataBar } from './WorkspaceMetadataBar'
import { WorkspaceFileBrowser } from './WorkspaceFileBrowser'
import { ChangedFilesView } from './ChangedFilesView'
import { CodeFileCollection } from '../code/CodeFileCollection'
import { getMockWorkspaceData } from './mockData'
import type { FileTreeNode } from '../code/FileTree'
import type { WorkspaceTab, WorkspaceState } from '@/types/workspace'

interface FilesWorkspaceProps {
  /** Generated files tree (from existing FileTreeContext) */
  generatedFiles: FileTreeNode[];
  /** Additional CSS classes */
  className?: string;
  /** Callback to hide the workspace */
  onHide?: () => void;
  /** Whether to hide content (for animations) */
  hideContent?: boolean;
  /** Absolute path to generated files output */
  absoluteOutputPath?: string;
  /** Relative path to generated files output */
  relativeOutputPath?: string;
}

export const FilesWorkspace = ({
  generatedFiles,
  className = "",
  onHide,
  hideContent = false,
  absoluteOutputPath,
  relativeOutputPath,
}: FilesWorkspaceProps) => {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('generated')
  
  // For now, use mock data for the workspace files
  // In the future, this will come from a WorkspaceContext or API
  const workspaceData: WorkspaceState = useMemo(() => getMockWorkspaceData(), [])
  
  // Calculate stats that include generated files
  const stats = useMemo(() => ({
    ...workspaceData.stats,
    generatedFiles: generatedFiles.length > 0 
      ? countFiles(generatedFiles)
      : 0,
  }), [workspaceData.stats, generatedFiles])
  
  // Determine which tabs should show counts/badges
  const tabCounts = useMemo(() => ({
    generated: stats.totalFiles,
    changed: stats.changedFiles,
  }), [stats])
  
  // Calculate change type counts for the Changed tab
  const changeStats = useMemo(() => {
    const added = workspaceData.changes.filter(c => c.changeType === 'added').length
    const modified = workspaceData.changes.filter(c => c.changeType === 'modified').length
    const deleted = workspaceData.changes.filter(c => c.changeType === 'deleted').length
    const totalAdditions = workspaceData.changes.reduce((sum, c) => sum + c.additions, 0)
    const totalDeletions = workspaceData.changes.reduce((sum, c) => sum + c.deletions, 0)
    return { added, modified, deleted, totalAdditions, totalDeletions, total: workspaceData.changes.length }
  }, [workspaceData.changes])

  return (
    <div className={cn("w-full h-full flex flex-col", className)}>
      {/* Header with title and hide button */}
      <div className="flex items-center justify-between py-2 px-4 lg:px-2">
        <h2 className="text-lg font-semibold text-gray-700">Files</h2>
        
        {onHide && (
          <button
            onClick={onHide}
            className="hidden lg:block p-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-all duration-200 cursor-pointer"
            title="Hide files workspace"
          >
            <ChevronLeft className="w-4 h-4 text-gray-600" />
          </button>
        )}
      </div>
      
      {/* Tab Bar - directly below title */}
      <WorkspaceTabBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        tabCounts={tabCounts}
        className="px-2"
      />
      
      {/* Metadata Bar - outside bordered area */}
      {activeTab === 'changed' ? (
        <div className="flex items-center gap-3 px-4 py-2 bg-gray-50 text-sm">
          <span className="text-gray-600">
            <span className="font-medium">{changeStats.total}</span> changed {changeStats.total === 1 ? 'file' : 'files'}
          </span>
          <span className="text-gray-300">|</span>
          <span className="text-green-600 font-medium">+{changeStats.totalAdditions}</span>
          <span className="text-red-600 font-medium">-{changeStats.totalDeletions}</span>
          <ChangeProportionBar additions={changeStats.totalAdditions} deletions={changeStats.totalDeletions} />
        </div>
      ) : activeTab === 'generated' ? (
        <GeneratedFilesInfoBar 
          outputPath={absoluteOutputPath} 
          fileCount={stats.generatedFiles} 
        />
      ) : (
        <WorkspaceMetadataBar
          gitInfo={workspaceData.gitInfo}
          localPath={activeTab === 'all' ? workspaceData.localPath : undefined}
          className="px-2"
        />
      )}
      
      {/* Bordered content area - file tree and viewers */}
      <div className="flex-1 flex flex-col border-y border-gray-400 overflow-hidden">
        {activeTab === 'generated' && (
          <CodeFileCollection
            data={generatedFiles}
            className="h-full"
            hideContent={hideContent}
            absoluteOutputPath={absoluteOutputPath}
            relativeOutputPath={relativeOutputPath}
            hideHeader={true}
          />
        )}
        
        {activeTab === 'all' && (
          <WorkspaceFileBrowser
            files={workspaceData.files}
            className="h-full"
          />
        )}
        
        {activeTab === 'changed' && (
          <ChangedFilesView
            changes={workspaceData.changes}
            className="h-full"
          />
        )}
      </div>
    </div>
  )
}

/**
 * Info bar for Generated files tab showing local folder path and file count
 */
function GeneratedFilesInfoBar({ outputPath, fileCount }: { outputPath?: string; fileCount: number }) {
  const [didCopy, setDidCopy] = useState(false)
  
  const handleCopyPath = () => {
    if (outputPath) {
      setDidCopy(true)
      copyTextToClipboard(outputPath)
      setTimeout(() => setDidCopy(false), 1500)
    }
  }
  
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-gray-50 text-sm">
      {/* Local folder path */}
      {outputPath ? (
        <div className="flex items-center gap-1.5 text-gray-700">
          <Folder className="w-4 h-4 text-gray-500" />
          <code className="font-mono text-xs text-gray-600">
            {outputPath}
          </code>
          <button
            onClick={handleCopyPath}
            className="p-0.5 text-gray-400 hover:text-gray-600 rounded cursor-pointer"
            title="Copy path"
          >
            {didCopy ? (
              <Check className="w-3.5 h-3.5 text-green-600" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-gray-500">
          <Folder className="w-4 h-4" />
          <span className="italic text-xs">No output path specified</span>
        </div>
      )}
      
      {/* File count on the right */}
      <span className="text-gray-500 text-xs">
        <span className="font-medium text-gray-700">{fileCount}</span> {fileCount === 1 ? 'file' : 'files'} generated
      </span>
    </div>
  )
}

/**
 * Count total files in a file tree
 */
function countFiles(nodes: FileTreeNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.type === 'file') {
      count++
    }
    if (node.children) {
      count += countFiles(node.children)
    }
  }
  return count
}

/**
 * GitHub-style proportion bar showing additions vs deletions
 * Renders 5 boxes colored green/red based on the proportion
 */
function ChangeProportionBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  const BOXES = 5
  
  // Calculate how many boxes should be green
  let greenBoxes = 0
  if (total > 0) {
    greenBoxes = Math.round((additions / total) * BOXES)
    // Ensure at least 1 green if there are additions, and at least 1 red if there are deletions
    if (additions > 0 && greenBoxes === 0) greenBoxes = 1
    if (deletions > 0 && greenBoxes === BOXES) greenBoxes = BOXES - 1
  }
  
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
