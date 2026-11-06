import React, { useState, useCallback, useMemo, useReducer } from "react"
import type { ReactNode } from "react"
import { GeneratedFilesContext, GeneratedFilesReviewContext } from "./GeneratedFilesContext.types"
import type { FileTreeResponse, TruncationInfo } from "./GeneratedFilesContext.types"
import {
  fileChanges,
  fileReviewReducer,
  filesByPath,
  initialFileReviewState,
} from "../lib/fileReview"
import { restoreFileReview, type SavedFileReview } from "../lib/sessionHistory"

interface GeneratedFilesProviderProps {
  children: ReactNode
}

export const GeneratedFilesProvider: React.FC<GeneratedFilesProviderProps> = ({ children }) => {
  // The tree and what the user reviewed of it change together.
  const [{ fileTree, reviewed, selectedPath }, dispatch] = useReducer(
    fileReviewReducer,
    initialFileReviewState,
  )
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [truncationInfo, setTruncationInfo] = useState<TruncationInfo | null>(null)

  const stableSetLocalPath = useCallback((path: string | null) => {
    setLocalPath(path)
  }, [])

  const updateGeneratedFileTree = useCallback(
    (response: FileTreeResponse | null, resumed?: { review: SavedFileReview | undefined }) => {
      if (!response) {
        dispatch({ type: "tree", fileTree: null })
        setTruncationInfo(null)
        return
      }
      dispatch({
        type: "tree",
        fileTree: response.fileTree,
        reviewed: resumed
          ? restoreFileReview(resumed.review, filesByPath(response.fileTree))
          : undefined,
      })
      setTruncationInfo(
        response.truncatedTree
          ? {
              truncatedTree: true,
              totalFiles: response.totalFiles ?? 0,
              heavyDirs: response.heavyDirs,
            }
          : null,
      )
    },
    [],
  )

  const value = useMemo(
    () => ({
      fileTree,
      truncationInfo,
      localPath,
      setLocalPath: stableSetLocalPath,
      updateGeneratedFileTree,
    }),
    [fileTree, truncationInfo, localPath, stableSetLocalPath, updateGeneratedFileTree],
  )

  // In a context of its own, so selecting a file doesn't re-render the
  // blocks that only update the tree.
  const review = useMemo(
    () => ({
      changes: fileChanges(filesByPath(fileTree), reviewed),
      reviewed,
      selectedPath,
      selectFile: (path: string) => dispatch({ type: "select", path }),
      dismissFiles: (paths: readonly string[]) => dispatch({ type: "dismiss", paths }),
      dismissAll: () => dispatch({ type: "dismiss-all" }),
    }),
    [fileTree, reviewed, selectedPath],
  )

  return (
    <GeneratedFilesContext.Provider value={value}>
      <GeneratedFilesReviewContext.Provider value={review}>
        {children}
      </GeneratedFilesReviewContext.Provider>
    </GeneratedFilesContext.Provider>
  )
}
