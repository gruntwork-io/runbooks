import React from 'react'
import type { RunbookTab } from '../../hooks/useRunbook'

interface TabBarProps {
  tabs: RunbookTab[]
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab }: TabBarProps) {
  if (tabs.length === 0) return null

  return (
    <div className="flex items-center border-b border-neutral-200 bg-neutral-50 overflow-x-auto">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`flex items-center gap-1 px-4 py-2 text-sm border-r border-neutral-200 cursor-pointer min-w-0 max-w-48 ${
            tab.id === activeTabId
              ? 'bg-white text-neutral-900 font-medium'
              : 'text-neutral-500 hover:bg-neutral-100'
          }`}
          onClick={() => onSelectTab(tab.id)}
        >
          <StatusDot state={tab.state} />
          <span className="truncate">{tab.name}</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onCloseTab(tab.id)
            }}
            className="ml-1 p-0.5 rounded hover:bg-neutral-200 text-neutral-400 hover:text-neutral-600 flex-shrink-0"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}

function StatusDot({ state }: { state: string }) {
  const colors: Record<string, string> = {
    idle: 'bg-neutral-300',
    loaded: 'bg-blue-400',
    running: 'bg-amber-400 animate-pulse',
    complete: 'bg-green-400',
    error: 'bg-red-400',
  }

  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${colors[state] || 'bg-neutral-300'}`} />
}
