import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { useWheelScrollFallback } from './useWheelScrollFallback'

// jsdom does no layout, so scroll geometry is set by hand on each element.
function makeScrollable(element: HTMLElement, { overflowing }: { overflowing: boolean }) {
  element.style.overflowY = 'auto'
  Object.defineProperty(element, 'scrollHeight', { value: overflowing ? 1000 : 100 })
  Object.defineProperty(element, 'clientHeight', { value: 100 })
}

function Page() {
  const runbookRef = useRef<HTMLDivElement>(null)
  const onWheel = useWheelScrollFallback(runbookRef)
  return (
    <div data-testid="page" onWheel={onWheel}>
      <div data-testid="gutter" />
      <div data-testid="runbook" ref={runbookRef}>
        <p data-testid="runbook-text">text</p>
      </div>
      <div data-testid="panel">
        <p data-testid="panel-text">text</p>
      </div>
      <div data-testid="empty-panel">
        <p data-testid="empty-panel-text">text</p>
      </div>
    </div>
  )
}

function renderPage() {
  render(<Page />)
  const runbook = screen.getByTestId('runbook')
  makeScrollable(runbook, { overflowing: true })
  makeScrollable(screen.getByTestId('panel'), { overflowing: true })
  makeScrollable(screen.getByTestId('empty-panel'), { overflowing: false })
  const scrollBy = vi.fn()
  runbook.scrollBy = scrollBy
  return { scrollBy }
}

describe('useWheelScrollFallback', () => {
  it('scrolls the target when the wheel turns over the gutter', () => {
    const { scrollBy } = renderPage()

    fireEvent.wheel(screen.getByTestId('gutter'), { deltaY: 40 })

    expect(scrollBy).toHaveBeenCalledWith({ top: 40 })
  })

  it('scrolls the target when the wheel turns over the page wrapper itself', () => {
    const { scrollBy } = renderPage()

    fireEvent.wheel(screen.getByTestId('page'), { deltaY: -25 })

    expect(scrollBy).toHaveBeenCalledWith({ top: -25 })
  })

  it('leaves the target alone when the wheel turns over the target', () => {
    const { scrollBy } = renderPage()

    fireEvent.wheel(screen.getByTestId('runbook-text'), { deltaY: 40 })

    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('leaves the target alone when the wheel turns over another scrolling element', () => {
    const { scrollBy } = renderPage()

    fireEvent.wheel(screen.getByTestId('panel-text'), { deltaY: 40 })

    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('scrolls the target when the wheel turns over an element whose content fits', () => {
    const { scrollBy } = renderPage()

    fireEvent.wheel(screen.getByTestId('empty-panel-text'), { deltaY: 40 })

    expect(scrollBy).toHaveBeenCalledWith({ top: 40 })
  })

  it('ignores horizontal-only gestures', () => {
    const { scrollBy } = renderPage()

    fireEvent.wheel(screen.getByTestId('gutter'), { deltaX: 40, deltaY: 0 })

    expect(scrollBy).not.toHaveBeenCalled()
  })
})
