import { useEffect } from "react"
import { useGeneratedFiles } from "@/hooks/useGeneratedFiles"
import { useGeneratedFilesReview } from "@/hooks/useGeneratedFilesReview"
import { useSessionHistory } from "@/contexts/useSessionHistory"
import type { FileTreeResponse } from "@/contexts/GeneratedFilesContext.types"
import {
  fileReviewChanged,
  GENERATED_FILES_REVIEW_ID,
  parseSavedFileReview,
} from "@/lib/sessionHistory"

/**
 * How long what is left to review has to stay the same before it is saved.
 * A template writes its files again as the user types, and every event the
 * history keeps has the reviewed content of the modified files.
 */
export const REVIEW_SAVE_DELAY_MS = 1000

interface GeneratedFilesHistoryProps {
  /** The files a resumed session's blocks wrote, once the check for the session has read them */
  resumedFiles: Partial<FileTreeResponse> | null | undefined
}

/**
 * Keeps the generated files in the session's history: it shows the files a
 * resumed session's blocks wrote, with the changes the user had yet to review
 * still highlighted, and saves what is left to review whenever it changes.
 *
 * Mount one inside the session's history provider, keyed like it.
 */
export function GeneratedFilesHistory({ resumedFiles }: GeneratedFilesHistoryProps) {
  const history = useSessionHistory()
  const { fileTree, updateGeneratedFileTree } = useGeneratedFiles()
  const { changes, reviewed } = useGeneratedFilesReview()

  useEffect(() => {
    if (!resumedFiles?.fileTree) return
    updateGeneratedFileTree(
      {
        fileTree: resumedFiles.fileTree,
        truncatedTree: resumedFiles.truncatedTree,
        totalFiles: resumedFiles.totalFiles,
        heavyDirs: resumedFiles.heavyDirs,
      },
      { review: parseSavedFileReview(history.saved(GENERATED_FILES_REVIEW_ID, "review")) },
    )
  }, [resumedFiles, history, updateGeneratedFileTree])

  // When a session opens, the files are still the previous session's. The
  // app clears them in the same commit, which cancels the timer before it
  // fires, so they are never saved as this session's.
  useEffect(() => {
    // No files (the session's are not shown yet, or were deleted): whatever
    // the history has is left, since restoring it skips files that are gone.
    if (fileTree === null) return
    const timer = setTimeout(() => {
      history.record(GENERATED_FILES_REVIEW_ID, "review", fileReviewChanged(changes, reviewed))
    }, REVIEW_SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [fileTree, reviewed, changes, history])

  return null
}
