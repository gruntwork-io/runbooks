import '@testing-library/jest-dom'
import { vi } from 'vitest'

// jsdom doesn't implement matchMedia. Stub it so providers/components that read
// prefers-color-scheme (e.g. ThemeProvider) work in tests. Individual tests can
// still override window.matchMedia for finer-grained control.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}
