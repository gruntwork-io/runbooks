import React from 'react'
import type { RecentRunbook } from '../../../shared/types'

interface SidebarProps {
  recentRunbooks: RecentRunbook[]
  onOpenFolder: () => void
  onOpenRecent: (runbook: RecentRunbook) => void
}

export function Sidebar({ recentRunbooks, onOpenFolder, onOpenRecent }: SidebarProps) {
  return (
    <aside className="w-64 border-r border-neutral-200 bg-white flex flex-col h-full">
      {/* Open folder button */}
      <div className="px-3 py-3">
        <button
          onClick={onOpenFolder}
          className="w-full px-3 py-2 text-sm font-medium text-neutral-700 bg-neutral-100 hover:bg-neutral-200 rounded-lg transition-colors flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
            />
          </svg>
          Open Runbook
        </button>
      </div>

      {/* Recent runbooks */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-2">
          <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
            Recent
          </h3>
        </div>
        {recentRunbooks.length === 0 ? (
          <div className="px-4 py-3 text-sm text-neutral-400">No recent runbooks</div>
        ) : (
          <ul className="px-2">
            {recentRunbooks.map((runbook) => (
              <li key={runbook.path}>
                <button
                  onClick={() => onOpenRecent(runbook)}
                  className="w-full text-left px-2 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 rounded-md transition-colors truncate"
                  title={runbook.path}
                >
                  <div className="font-medium truncate">{runbook.name}</div>
                  <div className="text-xs text-neutral-400 truncate">{runbook.path}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
