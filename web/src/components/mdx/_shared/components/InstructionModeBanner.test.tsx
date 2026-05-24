import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { InstructionModeProvider } from '@/contexts/InstructionModeContext'
import { INSTRUCTION_MODE_STORAGE_KEY } from '@/contexts/InstructionModeContext.types'
import { InstructionModeBanner } from './InstructionModeBanner'

function renderBanner(children: ReactNode = <InstructionModeBanner />) {
  return render(<InstructionModeProvider>{children}</InstructionModeProvider>)
}

describe('InstructionModeBanner', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('renders nothing when instruction mode is off', () => {
    renderBanner()
    expect(screen.queryByTestId('instruction-mode-banner')).toBeNull()
  })

  it('renders the banner when instruction mode is on', () => {
    localStorage.setItem(INSTRUCTION_MODE_STORAGE_KEY, 'true')
    renderBanner()
    const banner = screen.getByTestId('instruction-mode-banner')
    expect(banner).toBeInTheDocument()
    expect(banner.textContent).toMatch(/nothing here runs automatically/i)
  })
})
