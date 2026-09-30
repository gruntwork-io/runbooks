import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// jsdom has no canvas, so canvas-confetti is replaced with a fake cannon whose
// burst promises the test settles by hand (as the animation ending would).
const confettiMock = vi.hoisted(() => {
  const pending: Array<() => void> = []
  const state = {
    settle: () => {
      for (const resolve of pending.splice(0)) resolve()
    },
  }
  const fire = Object.assign(
    vi.fn(() => new Promise<null>((resolve) => { pending.push(() => resolve(null)) })),
    { reset: vi.fn() },
  )
  const create = vi.fn(() => fire)
  return { state, fire, create }
})

vi.mock('canvas-confetti', () => ({ default: { create: confettiMock.create } }))

const originalMatchMedia = window.matchMedia

function setReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: reduce && query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

// A fresh module per test, so the lazily created confetti instance doesn't
// carry over from one test to the next.
async function loadCelebrate() {
  vi.resetModules()
  return (await import('../celebrate')).celebrate
}

// Let the burst promise's .then() handlers run.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('celebrate', () => {
  beforeEach(() => {
    confettiMock.fire.mockClear()
    confettiMock.fire.reset.mockClear()
    confettiMock.create.mockClear()
    setReducedMotion(false)
  })

  afterEach(async () => {
    // Settle any burst still in flight so its listeners come off.
    confettiMock.state.settle()
    await flush()
    window.matchMedia = originalMatchMedia
  })

  it('fires confetti on the main thread, never in a blob: worker the CSP blocks', async () => {
    const celebrate = await loadCelebrate()

    celebrate()

    expect(confettiMock.create).toHaveBeenCalledOnce()
    expect(confettiMock.create).toHaveBeenCalledWith(undefined, expect.objectContaining({ useWorker: false }))
    expect(confettiMock.fire).toHaveBeenCalled()
  })

  it('reuses one confetti instance across celebrations', async () => {
    const celebrate = await loadCelebrate()

    celebrate()
    celebrate()

    expect(confettiMock.create).toHaveBeenCalledOnce()
  })

  it('does nothing when the user prefers reduced motion, checked each time it fires', async () => {
    const celebrate = await loadCelebrate()

    setReducedMotion(true)
    celebrate()
    expect(confettiMock.create).not.toHaveBeenCalled()
    expect(confettiMock.fire).not.toHaveBeenCalled()

    setReducedMotion(false)
    celebrate()
    expect(confettiMock.fire).toHaveBeenCalled()

    confettiMock.fire.mockClear()
    setReducedMotion(true)
    celebrate()
    expect(confettiMock.fire).not.toHaveBeenCalled()
  })

  it('clears the confetti on Escape', async () => {
    const celebrate = await loadCelebrate()
    celebrate()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(confettiMock.fire.reset).not.toHaveBeenCalled()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(confettiMock.fire.reset).toHaveBeenCalledOnce()
  })

  it('clears the confetti on a click anywhere', async () => {
    const celebrate = await loadCelebrate()
    celebrate()

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(confettiMock.fire.reset).toHaveBeenCalledOnce()
  })

  it('stops listening once the confetti has finished', async () => {
    const celebrate = await loadCelebrate()
    celebrate()

    confettiMock.state.settle()
    await flush()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(confettiMock.fire.reset).not.toHaveBeenCalled()
  })
})
