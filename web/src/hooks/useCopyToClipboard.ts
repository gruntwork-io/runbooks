import { useState, useCallback, useRef, useEffect } from 'react'
import { copyTextToClipboard } from '@/lib/utils'

/**
 * Hook that manages copy-to-clipboard with a temporary "copied" feedback state.
 * After copying, `didCopy` stays true for `duration` ms, then resets.
 *
 * @param duration - How long (ms) to keep the "copied" state active (default: 1500)
 */
export function useCopyToClipboard(duration = 1500) {
  const [didCopy, setDidCopy] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const copy = useCallback(async (text: string) => {
    const ok = await copyTextToClipboard(text)
    if (ok) {
      setDidCopy(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setDidCopy(false), duration)
    }
    return ok
  }, [duration])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return { didCopy, copy }
}
