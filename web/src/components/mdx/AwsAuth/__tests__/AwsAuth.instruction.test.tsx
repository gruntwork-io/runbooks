import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import AwsAuth from '../AwsAuth'

vi.mock('@/contexts/useInstructionMode', () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

// If the interactive path were taken, this hook would run and trigger detection.
// Spy on it to prove instruction mode never invokes it.
const useAwsAuthSpy = vi.fn(() => ({ authStatus: 'pending' }))
vi.mock('../hooks/useAwsAuth', () => ({
  useAwsAuth: () => useAwsAuthSpy(),
}))

describe('AwsAuth — instruction mode', () => {
  it('renders a plain "Log into AWS" instruction with the account qualifier', () => {
    render(
      <TestWrapper>
        <AwsAuth id="aws" ssoAccountId="123456789012" ssoRoleName="AdminAccess" />
      </TestWrapper>,
    )
    expect(screen.getByText(/Log into AWS in the/i)).toBeInTheDocument()
    expect(screen.getByText('123456789012')).toBeInTheDocument()
    expect(screen.getByText('AdminAccess')).toBeInTheDocument()
  })

  it('shows no credential capture UI and never calls useAwsAuth', () => {
    render(
      <TestWrapper>
        <AwsAuth id="aws" />
      </TestWrapper>,
    )
    expect(screen.getByText('Log into AWS')).toBeInTheDocument()
    expect(screen.queryByTestId('creds-form')).toBeNull()
    expect(screen.queryByRole('button', { name: /authenticate/i })).toBeNull()
    expect(useAwsAuthSpy).not.toHaveBeenCalled()
  })
})
