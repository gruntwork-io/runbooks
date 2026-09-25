import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { getCredentialTypeLabel } from '../utils'
import { AuthSuccess } from '../components/AuthSuccess'
import { DetectedCredentialsPrompt } from '../components/DetectedCredentialsPrompt'
import type { DetectedGoogleCredentials, GoogleCredentialType } from '../types'

// The credential type arrives from MAIN over IPC, so an unexpected value is
// possible at runtime even though the union type rules it out.
const UNRECOGNIZED = 'mystery_type' as GoogleCredentialType

describe('getCredentialTypeLabel', () => {
  it('labels every credential type', () => {
    expect(getCredentialTypeLabel('service_account')).toBe('Service account key')
    expect(getCredentialTypeLabel('authorized_user')).toBe('User credentials (ADC)')
    expect(getCredentialTypeLabel('external_account')).toBe('Workload identity federation')
    expect(getCredentialTypeLabel('impersonated_service_account')).toBe('Impersonated service account')
    expect(getCredentialTypeLabel('access_token')).toBe('Access token')
    expect(getCredentialTypeLabel('gce_metadata')).toBe('Compute Engine metadata')
  })

  it('returns null for a missing or unrecognized type', () => {
    expect(getCredentialTypeLabel(undefined)).toBeNull()
    expect(getCredentialTypeLabel('' as GoogleCredentialType)).toBeNull()
    expect(getCredentialTypeLabel(UNRECOGNIZED)).toBeNull()
    expect(getCredentialTypeLabel('toString' as GoogleCredentialType)).toBeNull()
  })
})

// Each card picks its own fallback: the success card hides the label, the
// confirmation prompt always has a "Type:" row to fill.
describe('credential type on the cards', () => {
  const detected: DetectedGoogleCredentials = {
    projectId: 'my-proj',
    principal: 'dev@example.com',
    credentialType: 'authorized_user',
    source: 'adc',
  }

  it('the confirmation prompt labels the type, and says Unknown for an unrecognized one', () => {
    const { rerender } = render(
      <DetectedCredentialsPrompt credentials={detected} onConfirm={() => {}} onReject={() => {}} />,
    )
    expect(screen.getByText('User credentials (ADC)')).toBeInTheDocument()

    rerender(
      <DetectedCredentialsPrompt
        credentials={{ ...detected, credentialType: UNRECOGNIZED }}
        onConfirm={() => {}}
        onReject={() => {}}
      />,
    )
    expect(screen.getByText('Unknown')).toBeInTheDocument()
  })

  it('the success card labels the type, and hides the label for an unrecognized one', () => {
    const { rerender } = render(
      <AuthSuccess
        accountInfo={{ projectId: 'my-proj', credentialType: 'service_account' }}
        warningMessage={null}
      />,
    )
    expect(screen.getByText('Service account key')).toBeInTheDocument()

    rerender(
      <AuthSuccess
        accountInfo={{ projectId: 'my-proj', credentialType: UNRECOGNIZED }}
        warningMessage={null}
      />,
    )
    expect(screen.queryByText('Service account key')).toBeNull()
    expect(screen.queryByText('Unknown')).toBeNull()
  })
})
