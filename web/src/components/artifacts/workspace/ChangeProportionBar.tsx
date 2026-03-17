/**
 * GitHub-style proportion bar showing additions vs deletions
 */
export function ChangeProportionBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  const BOXES = 5

  if (total === 0) {
    return (
      <div className="flex items-center gap-0.5">
        {Array.from({ length: BOXES }).map((_, i) => (
          <div key={`n-${i}`} className="w-2 h-2 rounded-sm bg-gray-300" />
        ))}
      </div>
    )
  }

  let greenBoxes = Math.round((additions / total) * BOXES)
  if (additions > 0 && greenBoxes === 0) greenBoxes = 1
  if (deletions > 0 && greenBoxes === BOXES) greenBoxes = BOXES - 1

  const redBoxes = BOXES - greenBoxes

  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: greenBoxes }).map((_, i) => (
        <div key={`g-${i}`} className="w-2 h-2 rounded-sm bg-green-500" />
      ))}
      {Array.from({ length: redBoxes }).map((_, i) => (
        <div key={`r-${i}`} className="w-2 h-2 rounded-sm bg-red-500" />
      ))}
    </div>
  )
}
