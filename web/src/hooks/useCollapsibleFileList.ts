import { useState, useRef, useMemo, useCallback } from "react"
import {
  MAX_DISPLAYED_FILES,
  AUTO_COLLAPSE_THRESHOLD,
  SHOW_MORE_INCREMENT,
} from "@/lib/fileListDisplay"

/**
 * State machine for collapsible, paginated file lists.
 *
 * `changeKey` controls when auto-collapse and display-limit reset fire:
 * - Count-based lists (ChangedFilesView): pass `items.length`
 * - Identity-based lists (CodeFileCollection): pass the stable id-set key
 *   (e.g. `fileItems.map(f => f.id).join('\0')`)
 *
 * The reset compares `changeKey`, not `items`, so each call site preserves
 * its original change-detection strategy.
 */
export function useCollapsibleFileList<T>({
  items,
  getKey,
  changeKey,
}: {
  items: readonly T[]
  getKey: (item: T) => string
  changeKey: string | number
}) {
  const [collapsedFiles, setCollapsedFiles] = useState(() => initialCollapsed(items, getKey))
  const [displayLimit, setDisplayLimit] = useState(MAX_DISPLAYED_FILES)
  const [prevChangeKey, setPrevChangeKey] = useState(changeKey)
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  if (prevChangeKey !== changeKey) {
    setPrevChangeKey(changeKey)
    setCollapsedFiles(initialCollapsed(items, getKey))
    setDisplayLimit(MAX_DISPLAYED_FILES)
  }

  const displayedItems = useMemo(() => items.slice(0, displayLimit), [items, displayLimit])
  const hasMoreItems = items.length > displayLimit

  const toggleCollapse = useCallback((key: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const showMore = useCallback(() => {
    setDisplayLimit((prev) => prev + SHOW_MORE_INCREMENT)
  }, [])

  const expandAndJump = useCallback(
    (key: string, index: number) => {
      setCollapsedFiles((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      if (index >= displayLimit) {
        setDisplayLimit(index + 1)
      }
      requestAnimationFrame(() => {
        const el = itemRefs.current.get(key)
        if (el) {
          el.scrollIntoView({ behavior: "auto", block: "start" })
        }
      })
    },
    [displayLimit],
  )

  const setItemRef = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) {
      itemRefs.current.set(key, el)
    } else {
      itemRefs.current.delete(key)
    }
  }, [])

  return {
    collapsedFiles,
    displayedItems,
    hasMoreItems,
    toggleCollapse,
    showMore,
    expandAndJump,
    setItemRef,
  }
}

/**
 * Collapse every item of a large list; start a smaller one fully expanded.
 * The empty set also drops stale collapsed keys carried over from a previous
 * (larger) changeKey.
 */
function initialCollapsed<T>(items: readonly T[], getKey: (item: T) => string): Set<string> {
  if (items.length > AUTO_COLLAPSE_THRESHOLD) return new Set(items.map(getKey))
  return new Set()
}
