/**
 * @fileoverview Workspace Component
 *
 * Main container for the files workspace with two-tier navigation:
 *
 * Top tier (context): Switches between "Repository" and "Generated files"
 *   - Only shown when both a worktree and generated files exist
 *
 * Second tier (sub-tabs): "All files" and "Changed files" within Repository context
 *   - Shown when a git worktree is registered
 *
 * When nothing is available, shows an empty state message.
 * When only one source exists, the context bar is hidden.
 */

import { useState, useMemo, useEffect, useRef } from 'react'
import { ChevronLeft, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ContextSwitcher } from './ContextSwitcher'
import { RepositoryTabs } from './RepositoryTabs'
import { RepositoryMetadataBar } from './RepositoryMetadataBar'
import { GeneratedFilesMetadataBar } from './GeneratedFilesMetadataBar'
import { RepositoryFileBrowser } from './RepositoryFileBrowser'
import { ChangedFilesView } from './ChangedFilesView'
import { CodeFileCollection } from '../code/CodeFileCollection'
import { useGitWorkTree } from '@/contexts/GitWorkTreeContext'
import { useWorkspaceTree } from '@/hooks/useWorkspaceTree'
import { useWorkspaceChanges } from '@/hooks/useWorkspaceChanges'
import type { FileTreeNode } from '../code/FileTree'
import type { WorkspaceTab, WorkspaceContext } from '@/types/workspace'

interface WorkspaceProps {
  /** Generated files tree (from GeneratedFilesContext) */
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

export const Workspace = ({
  generatedFiles,
  className = "",
  onHide,
  hideContent = false,
  absoluteOutputPath,
  relativeOutputPath,
}: WorkspaceProps) => {
  const [activeContext, setActiveContext] = useState<WorkspaceContext>('generated')
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('all')
  const hasAutoSwitched = useRef(false)
  const prevTotalChanges = useRef(0)

  // Git worktree data
  const { workTrees, activeWorkTree, activeWorkTreeId, setActiveWorkTree } = useGitWorkTree()
  const { tree: workspaceTree, isLoading: treeLoading, error: treeError, refetch: refetchTree } = useWorkspaceTree()
  const { changes, totalChanges, tooManyChanges, isLoading: changesLoading, fetchFileDiff } = useWorkspaceChanges()

  // Determine what's available
  const hasGeneratedFiles = generatedFiles.length > 0
  const hasWorkTree = workTrees.length > 0
  const hasNothing = !hasGeneratedFiles && !hasWorkTree
  const hasBothContexts = hasGeneratedFiles && hasWorkTree

  // Calculate generated file count
  const generatedFileCount = useMemo(() => countFiles(generatedFiles), [generatedFiles])

  // Auto-switch to repository context when first worktree is registered
  useEffect(() => {
    if (hasWorkTree && !hasAutoSwitched.current) {
      hasAutoSwitched.current = true
      setActiveContext('repository')
      setActiveTab('all')
    }
  }, [hasWorkTree])

  // Auto-switch to Changed files tab when changes first appear,
  // and refresh the file tree whenever the set of changes updates
  // (files may have been added or deleted).
  useEffect(() => {
    if (prevTotalChanges.current === 0 && totalChanges > 0 && hasWorkTree) {
      setActiveContext('repository')
      setActiveTab('changed')
    }
    if (totalChanges !== prevTotalChanges.current && hasWorkTree) {
      refetchTree()
    }
    prevTotalChanges.current = totalChanges
  }, [totalChanges, hasWorkTree, refetchTree])

  // Ensure active context is valid
  useEffect(() => {
    if (activeContext === 'repository' && !hasWorkTree && hasGeneratedFiles) {
      setActiveContext('generated')
    } else if (activeContext === 'generated' && !hasGeneratedFiles && hasWorkTree) {
      setActiveContext('repository')
      setActiveTab('all')
    }
  }, [activeContext, hasWorkTree, hasGeneratedFiles])

  // Determine the effective view: what's actually showing
  const isRepositoryView = activeContext === 'repository' || (!hasBothContexts && hasWorkTree)
  const isGeneratedView = activeContext === 'generated' || (!hasBothContexts && hasGeneratedFiles)

  // Tab counts for badges
  const tabCounts = useMemo(() => ({
    changed: totalChanges,
  }), [totalChanges])

  // Change stats for the metadata bar
  const changeStats = useMemo(() => {
    const added = changes.filter(c => c.changeType === 'added').length
    const modified = changes.filter(c => c.changeType === 'modified').length
    const deleted = changes.filter(c => c.changeType === 'deleted').length
    const totalAdditions = changes.reduce((sum, c) => sum + c.additions, 0)
    const totalDeletions = changes.reduce((sum, c) => sum + c.deletions, 0)
    return { added, modified, deleted, totalAdditions, totalDeletions, total: changes.length }
  }, [changes])

  // Git info for metadata bar
  const gitInfo = useMemo(() => {
    if (!activeWorkTree) return null
    return activeWorkTree.gitInfo
  }, [activeWorkTree])

  // Empty state: nothing to show
  if (hasNothing) {
    return (
      <div className={cn("w-full h-full flex flex-col", className)}>
        <div className="flex items-center justify-between py-2 px-3">
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
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center px-8">
            <FolderOpen className="w-16 h-16 mx-auto mb-3 text-gray-300" />
            <p className="text-sm text-gray-500">
              Files generated by blocks and cloned repositories will appear here.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("w-full h-full flex flex-col", className)}>
      {/* Header with title and hide button */}
      <div className="flex items-center justify-between py-2 px-3">
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

      {/* Top-level context bar - only when both repository and generated files exist */}
      {hasBothContexts && (
        <ContextSwitcher
          activeContext={activeContext}
          onContextChange={setActiveContext}
          generatedCount={generatedFileCount}
          className="px-3"
        />
      )}

      {/* Repository context */}
      {isRepositoryView && (
        <>
          <RepositoryMetadataBar
            gitInfo={gitInfo}
            localPath={activeWorkTree?.localPath}
            workTrees={workTrees}
            activeWorkTreeId={activeWorkTreeId}
            onWorktreeSelect={setActiveWorkTree}
            className="px-3"
          />

          {/* Sub-tabs: All files / Changed files — flush against the content border */}
          <div className="flex items-end px-3 border-b border-gray-300">
            <RepositoryTabs
              activeTab={activeTab}
              onTabChange={setActiveTab}
              tabCounts={tabCounts}
              className="mb-[-1px]"
            />
          </div>

          {/* Change stats (shown under Changed files tab) */}
          {activeTab === 'changed' && changeStats.total > 0 && (
            <div className="flex items-center gap-3 px-3 py-1.5 bg-gray-50 border-b border-gray-200 text-sm">
              <span className="text-gray-600">
                <span className="font-medium">{changeStats.total}</span> changed {changeStats.total === 1 ? 'file' : 'files'}
              </span>
              <span className="text-gray-300">|</span>
              <span className="text-green-600 font-medium">+{changeStats.totalAdditions}</span>
              <span className="text-red-600 font-medium">-{changeStats.totalDeletions}</span>
              <ChangeProportionBar additions={changeStats.totalAdditions} deletions={changeStats.totalDeletions} />
            </div>
          )}
        </>
      )}

      {/* Generated files context */}
      {isGeneratedView && (
        <GeneratedFilesMetadataBar
          absolutePath={absoluteOutputPath}
          relativePath={relativeOutputPath}
          fileCount={generatedFileCount}
          className="px-3"
        />
      )}

      {/* Content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {isGeneratedView && (
          <CodeFileCollection
            data={generatedFiles}
            className="h-full"
            hideContent={hideContent}
            absoluteOutputPath={absoluteOutputPath}
            relativeOutputPath={relativeOutputPath}
            hideHeader={true}
          />
        )}

        {isRepositoryView && activeTab === 'all' && (
          <RepositoryFileBrowser
            tree={workspaceTree}
            isLoading={treeLoading}
            error={treeError}
            onRetry={refetchTree}
            className="h-full"
          />
        )}

        {isRepositoryView && activeTab === 'changed' && (
          <ChangedFilesView
            changes={changes}
            tooManyChanges={tooManyChanges}
            totalChanges={totalChanges}
            isLoading={changesLoading}
            onLoadDiff={fetchFileDiff}
            className="h-full"
          />
        )}
      </div>
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
 */
function ChangeProportionBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  const BOXES = 5
  
  let greenBoxes = 0
  if (total > 0) {
    greenBoxes = Math.round((additions / total) * BOXES)
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
