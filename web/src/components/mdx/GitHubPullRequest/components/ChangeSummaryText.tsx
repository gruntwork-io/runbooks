import type { ChangeSummary } from "./PRForm"

interface ChangeSummaryTextProps {
  changeSummary: ChangeSummary
}

/** Renders inline "+N, −M" stats for a change summary */
export function ChangeSummaryText({ changeSummary }: ChangeSummaryTextProps) {
  if (changeSummary.additions === 0 && changeSummary.deletions === 0) return null

  return (
    <>
      {' '}(
      {changeSummary.additions > 0 && (
        <span className="text-green-600 font-medium">+{changeSummary.additions}</span>
      )}
      {changeSummary.additions > 0 && changeSummary.deletions > 0 && ', '}
      {changeSummary.deletions > 0 && (
        <span className="text-red-600 font-medium">&minus;{changeSummary.deletions}</span>
      )}
      )
    </>
  )
}
