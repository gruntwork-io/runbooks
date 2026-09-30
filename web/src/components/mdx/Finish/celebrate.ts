import confetti from 'canvas-confetti'

/**
 * The confetti <Finish> fires when a runbook is finished.
 *
 * The library draws on a full-window canvas with `pointer-events: none`, so it
 * never blocks the page, and removes the canvas when the last piece falls
 * (about 3 seconds). Escape or a click anywhere clears it straight away.
 */

let fire: confetti.CreateTypes | null = null

// Checked every time, not once: the library reads the preference only when an
// instance is created, so it would miss a change made after the first burst.
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const BURST: confetti.Options = { particleCount: 90, spread: 70, startVelocity: 55 }

export function celebrate(): void {
  if (prefersReducedMotion()) return

  // useWorker: false, because the default instance draws in a blob: Worker and
  // the packaged app's CSP (script-src 'self', no worker-src) blocks those.
  fire ??= confetti.create(undefined, { resize: true, useWorker: false })
  const cannon = fire

  const dismiss = () => cannon.reset()
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') dismiss()
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('pointerdown', dismiss, true)
  const stopListening = () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('pointerdown', dismiss, true)
  }

  // One burst from each bottom corner, aimed up and in. Both share the
  // animation, so either promise settles when it ends or is reset.
  Promise.all([
    cannon({ ...BURST, angle: 60, origin: { x: 0, y: 0.9 } }),
    cannon({ ...BURST, angle: 120, origin: { x: 1, y: 0.9 } }),
  ]).then(stopListening, stopListening)
}
