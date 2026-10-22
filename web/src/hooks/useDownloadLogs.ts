import { useCallback } from "react"
import { useLogs } from "@/contexts/useLogs"
import {
  createLogsZipRaw,
  createLogsZipJson,
  downloadBlob,
  generateAllLogsZipFilename,
} from "@/lib/logs"

/**
 * Downloads every block's logs as a zip, for the Header menu and the command
 * palette. Lives in a hook so App doesn't have to read LogsContext to hand the
 * handlers down (see ClearLogsOnRunbookChange in App.tsx).
 */
export function useDownloadLogs() {
  const { getAllLogs, hasLogs } = useLogs()

  const downloadRaw = useCallback(async () => {
    const blob = await createLogsZipRaw(getAllLogs())
    downloadBlob(blob, generateAllLogsZipFilename())
  }, [getAllLogs])

  const downloadJson = useCallback(async () => {
    const blob = await createLogsZipJson(getAllLogs())
    downloadBlob(blob, generateAllLogsZipFilename())
  }, [getAllLogs])

  return { hasLogs, downloadRaw, downloadJson }
}
