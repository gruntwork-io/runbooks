import React from 'react'
import { Sidebar } from './components/Layout/Sidebar'
import { TabBar } from './components/Layout/TabBar'
import { MDXRenderer } from './components/MDX/MDXRenderer'
import { useRunbook } from './hooks/useRunbook'
import logoDark from './assets/logo-dark.svg'

export default function App() {
  const {
    tabs,
    activeTab,
    activeTabId,
    recentRunbooks,
    setActiveTabId,
    openFolder,
    openRecent,
    closeTab,
  } = useRunbook()

  return (
    <div className="flex flex-col h-screen bg-white">
      {/* Top titlebar - full width, draggable, centered branding */}
      <div className="titlebar-drag h-12 border-b border-neutral-200 flex items-center px-4 flex-shrink-0">
        <div className="flex-1" />
        <div className="flex items-center gap-2 titlebar-no-drag">
          <img src={logoDark} alt="Runbooks" className="w-5 h-5" />
          <span className="text-sm font-semibold text-neutral-500">
            Runbooks
          </span>
        </div>
        <div className="flex-1" />
      </div>

      {/* Below titlebar: sidebar + main content */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <Sidebar
          recentRunbooks={recentRunbooks}
          onOpenFolder={openFolder}
          onOpenRecent={openRecent}
        />

        {/* Main content area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Tab bar */}
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={setActiveTabId}
            onCloseTab={closeTab}
          />

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            {activeTab ? (
              activeTab.state === 'error' && !activeTab.runbook ? (
                <div className="p-6">
                  <div className="rounded-lg bg-red-50 border border-red-200 p-4">
                    <h3 className="text-sm font-medium text-red-800">
                      Unable to load runbook
                    </h3>
                    <p className="mt-1 text-sm text-red-600">
                      {(activeTab.error || '')
                        .replace(/^Error invoking remote method '[^']+': Error: /, '')
                        .replace(/^Error: /, '')}
                    </p>
                  </div>
                </div>
              ) : activeTab.runbook ? (
                <MDXRenderer
                  content={activeTab.runbook.content}
                  runbookFolder={activeTab.runbook.folderPath}
                />
              ) : null
            ) : (
              <EmptyState onOpenFolder={openFolder} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function EmptyState({ onOpenFolder }: { onOpenFolder: () => void }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-md">
        <div className="mx-auto w-16 h-16 rounded-2xl bg-neutral-100 flex items-center justify-center mb-4">
          <img src={logoDark} alt="Runbooks" className="w-10 h-10" />
        </div>
        <h2 className="text-lg font-semibold text-neutral-900 mb-2">
          Welcome to Runbooks
        </h2>
        <p className="text-sm text-neutral-500 mb-6">
          Open a runbook folder to get started.
        </p>
        <button
          onClick={onOpenFolder}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Open Runbook
        </button>
      </div>
    </div>
  )
}
