import { useState, useCallback, useEffect } from 'react'
import type { RunbookData, RecentRunbook } from '../../shared/types'

export type RunbookState = 'idle' | 'loaded' | 'error'

export interface RunbookTab {
  id: string
  folderPath: string
  name: string
  runbook: RunbookData | null
  state: RunbookState
  error: string | null
}

let tabIdCounter = 0
function nextTabId(): string {
  return `tab-${++tabIdCounter}`
}

export function useRunbook() {
  const [tabs, setTabs] = useState<RunbookTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [recentRunbooks, setRecentRunbooks] = useState<RecentRunbook[]>([])

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  // Load recent runbooks on mount
  useEffect(() => {
    window.runbooks.getRecentRunbooks().then(setRecentRunbooks)
  }, [])

  const updateTab = useCallback(
    (tabId: string, updates: Partial<RunbookTab>) => {
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ...updates } : t)))
    },
    []
  )

  const openFolder = useCallback(async () => {
    const folder = await window.runbooks.selectFolder()
    if (!folder) return

    const name = folder.split('/').pop() || folder

    try {
      const { runbook } = await window.runbooks.loadRunbook(folder)

      const newTab: RunbookTab = {
        id: nextTabId(),
        folderPath: folder,
        name: runbook.frontMatter.title || name,
        runbook,
        state: 'loaded',
        error: null,
      }

      setTabs((prev) => [...prev, newTab])
      setActiveTabId(newTab.id)

      // Add to recent
      const updated = await window.runbooks.addRecentRunbook({ path: folder, name: newTab.name })
      setRecentRunbooks(updated)
    } catch (err) {
      const newTab: RunbookTab = {
        id: nextTabId(),
        folderPath: folder,
        name,
        runbook: null,
        state: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
      setTabs((prev) => [...prev, newTab])
      setActiveTabId(newTab.id)
    }
  }, [])

  const openRecent = useCallback(async (recent: RecentRunbook) => {
    try {
      const { runbook } = await window.runbooks.loadRunbook(recent.path)

      const newTab: RunbookTab = {
        id: nextTabId(),
        folderPath: recent.path,
        name: runbook.frontMatter.title || recent.name,
        runbook,
        state: 'loaded',
        error: null,
      }

      setTabs((prev) => [...prev, newTab])
      setActiveTabId(newTab.id)

      const updated = await window.runbooks.addRecentRunbook({
        path: recent.path,
        name: newTab.name,
      })
      setRecentRunbooks(updated)
    } catch (err) {
      const newTab: RunbookTab = {
        id: nextTabId(),
        folderPath: recent.path,
        name: recent.name,
        runbook: null,
        state: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
      setTabs((prev) => [...prev, newTab])
      setActiveTabId(newTab.id)
    }
  }, [])

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const remaining = prev.filter((t) => t.id !== tabId)
        if (activeTabId === tabId) {
          setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null)
        }
        return remaining
      })
    },
    [activeTabId]
  )

  return {
    tabs,
    activeTab,
    activeTabId,
    recentRunbooks,
    setActiveTabId,
    openFolder,
    openRecent,
    closeTab,
    updateTab,
  }
}
