/**
 * @fileoverview WorkspaceMetadataBar Component
 * 
 * Displays git repository info and workspace statistics.
 */

import { GitBranch, FolderGit2, FileCode, FilePlus, FileEdit } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GitRepoInfo, WorkspaceStats } from '@/types/workspace'

interface WorkspaceMetadataBarProps {
  /** Git repository information */
  gitInfo: GitRepoInfo | null;
  /** Workspace statistics */
  stats: WorkspaceStats & { generatedFiles: number };
  /** Additional CSS classes */
  className?: string;
}

export const WorkspaceMetadataBar = ({
  gitInfo,
  stats,
  className = "",
}: WorkspaceMetadataBarProps) => {
  // If no git info, show a minimal state
  if (!gitInfo) {
    return (
      <div className={cn("px-4 py-2 bg-gray-50 text-sm", className)}>
        <div className="flex items-center gap-2 text-gray-500">
          <FolderGit2 className="w-4 h-4" />
          <span className="italic">No repository connected</span>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("px-4 py-2 bg-gray-50", className)}>
      {/* Git Info Row */}
      <div className="flex items-center gap-4 text-sm">
        {/* Repository */}
        <div className="flex items-center gap-1.5 text-gray-700">
          <FolderGit2 className="w-4 h-4 text-gray-500" />
          <a
            href={`https://${gitInfo.repoUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-blue-600 hover:underline"
          >
            {gitInfo.repoOwner}/{gitInfo.repoName}
          </a>
        </div>
        
        {/* Branch */}
        <div className="flex items-center gap-1.5 text-gray-700">
          <GitBranch className="w-4 h-4 text-gray-500" />
          <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">
            {gitInfo.branch}
          </span>
        </div>
        
        {/* Commit SHA (truncated) */}
        {gitInfo.commitSha && (
          <div className="flex items-center gap-1.5 text-gray-500 text-xs">
            <span className="font-mono bg-gray-100 px-1.5 py-0.5 rounded">
              {gitInfo.commitSha.slice(0, 7)}
            </span>
          </div>
        )}
      </div>
      
      {/* Stats Row */}
      <div className="flex items-center gap-4 mt-2 text-xs text-gray-600">
        <StatBadge
          icon={<FileCode className="w-3.5 h-3.5" />}
          label="Total"
          value={stats.totalFiles}
        />
        <StatBadge
          icon={<FilePlus className="w-3.5 h-3.5 text-green-600" />}
          label="Generated"
          value={stats.generatedFiles}
          valueClassName="text-green-700"
        />
        <StatBadge
          icon={<FileEdit className="w-3.5 h-3.5 text-amber-600" />}
          label="Changed"
          value={stats.changedFiles}
          valueClassName="text-amber-700"
        />
        {(stats.totalAdditions > 0 || stats.totalDeletions > 0) && (
          <div className="flex items-center gap-1.5">
            <span className="text-green-600">+{stats.totalAdditions}</span>
            <span className="text-red-600">-{stats.totalDeletions}</span>
          </div>
        )}
      </div>
    </div>
  )
}

interface StatBadgeProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  valueClassName?: string;
}

const StatBadge = ({ icon, label, value, valueClassName = "" }: StatBadgeProps) => (
  <div className="flex items-center gap-1">
    {icon}
    <span>{label}:</span>
    <span className={cn("font-medium", valueClassName)}>{value}</span>
  </div>
)
