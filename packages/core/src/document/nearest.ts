/**
 * The candidate an author most likely meant by `written`: the same name in
 * another case, or one a few edits away. Undefined when none is close.
 */
export function nearest(written: string, candidates: Iterable<string>): string | undefined {
  const lower = written.toLowerCase()
  let best: string | undefined
  let bestDistance = Math.max(1, Math.floor(written.length / 3)) + 1
  for (const candidate of candidates) {
    if (candidate === written) continue
    const distance =
      candidate.toLowerCase() === lower ? 0 : editDistance(lower, candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution))
    }
    previous = current
  }
  return previous[b.length]!
}
