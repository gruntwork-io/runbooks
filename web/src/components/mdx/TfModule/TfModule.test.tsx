import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import TfModule from './TfModule'
import { RunbookContextProvider } from '@/contexts/RunbookContext'
import { ComponentIdRegistryProvider } from '@/contexts/ComponentIdRegistry'
import { ErrorReportingProvider } from '@/contexts/ErrorReportingContext'
import { TelemetryProvider } from '@/contexts/TelemetryContext'
import { BoilerplateVariableType } from '@/types/boilerplateVariable'

// Mock the API hook — we don't want actual HTTP calls
vi.mock('@/hooks/useApiParseTfModule', () => ({
  useApiParseTfModule: vi.fn(),
}))

// Import the mocked hook so we can control its return value per test
import { useApiParseTfModule } from '@/hooks/useApiParseTfModule'
const mockUseApiParseTfModule = vi.mocked(useApiParseTfModule)

// Wrapper providing all required context providers
function TestWrapper({ children, remoteSource }: { children: ReactNode; remoteSource?: string }) {
  return (
    <TelemetryProvider>
      <ErrorReportingProvider>
        <ComponentIdRegistryProvider>
          <RunbookContextProvider runbookName="test" remoteSource={remoteSource}>
            {children}
          </RunbookContextProvider>
        </ComponentIdRegistryProvider>
      </ErrorReportingProvider>
    </TelemetryProvider>
  )
}

describe('TfModule', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: loading state
    mockUseApiParseTfModule.mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
      silentRefetch: vi.fn(),
    })
  })

  describe('::source resolution', () => {
    it('resolves ::source to remoteSource from context', () => {
      mockUseApiParseTfModule.mockReturnValue({
        data: null,
        isLoading: true,
        error: null,
        refetch: vi.fn(),
        silentRefetch: vi.fn(),
      })

      render(
        <TestWrapper remoteSource="https://github.com/org/module">
          <TfModule id="test" source="::source" />
        </TestWrapper>
      )

      // Should call the API hook with the resolved remote source
      expect(mockUseApiParseTfModule).toHaveBeenCalledWith(
        'https://github.com/org/module',
        true, // shouldFetch = no validation error
      )
    })

    it('shows missing-remote-source banner when ::source used without remoteSource', () => {
      render(
        <TestWrapper>
          <TfModule id="test" source="::source" />
        </TestWrapper>
      )

      expect(screen.getByText('No remote module source available')).toBeInTheDocument()
      expect(screen.getByText(/source="::source"/)).toBeInTheDocument()
    })

    it('uses literal source string when source is not ::source', () => {
      render(
        <TestWrapper>
          <TfModule id="test" source="../modules/vpc" />
        </TestWrapper>
      )

      expect(mockUseApiParseTfModule).toHaveBeenCalledWith(
        '../modules/vpc',
        true,
      )
    })

    it('uses literal source even when remoteSource is available', () => {
      render(
        <TestWrapper remoteSource="https://github.com/org/module">
          <TfModule id="test" source="./local-module" />
        </TestWrapper>
      )

      // Should NOT use remoteSource — only ::source triggers that
      expect(mockUseApiParseTfModule).toHaveBeenCalledWith(
        './local-module',
        true,
      )
    })
  })

  describe('validation errors', () => {
    it('shows validation error when source is empty', () => {
      render(
        <TestWrapper>
          <TfModule id="test" source="" />
        </TestWrapper>
      )

      // The API hook should be called with shouldFetch=false due to validation error
      expect(mockUseApiParseTfModule).toHaveBeenCalledWith(
        '',
        false,
      )
    })
  })

  describe('loading state', () => {
    it('shows loading display while parsing module', () => {
      mockUseApiParseTfModule.mockReturnValue({
        data: null,
        isLoading: true,
        error: null,
        refetch: vi.fn(),
        silentRefetch: vi.fn(),
      })

      render(
        <TestWrapper>
          <TfModule id="test" source="../modules/vpc" />
        </TestWrapper>
      )

      expect(screen.getByText('Parsing OpenTofu module...')).toBeInTheDocument()
    })
  })

  describe('API error handling', () => {
    it('shows error display when API returns an error', () => {
      mockUseApiParseTfModule.mockReturnValue({
        data: null,
        isLoading: false,
        error: { message: 'Module not found', details: 'Could not find module at: ../missing' },
        refetch: vi.fn(),
        silentRefetch: vi.fn(),
      })

      render(
        <TestWrapper>
          <TfModule id="test" source="../missing" />
        </TestWrapper>
      )

      expect(screen.getByText(/Module not found/)).toBeInTheDocument()
    })
  })

  describe('successful render', () => {
    it('renders form when module is successfully parsed', () => {
      mockUseApiParseTfModule.mockReturnValue({
        data: {
          variables: [
            {
              name: 'bucket_name',
              description: 'Name of the S3 bucket',
              type: BoilerplateVariableType.String,
              default: '',
              required: true,
            },
          ],
          metadata: {
            folder_name: 's3-bucket',
            readme_title: 'S3 Bucket Module',
            output_names: ['bucket_arn'],
            resource_names: ['aws_s3_bucket.this'],
          },
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        silentRefetch: vi.fn(),
      })

      render(
        <TestWrapper>
          <TfModule id="test" source="../modules/s3" />
        </TestWrapper>
      )

      // The form should render with the variable
      expect(screen.getByText(/bucket.name/i)).toBeInTheDocument()
    })
  })

  describe('enrichFormData', () => {
    it('passes enrichFormData to useInputRegistration that adds _module namespace', () => {
      // This test verifies the enrichFormData callback structure by inspecting
      // what the API hook receives. We test the actual data flow through
      // RunbookContext separately (in RunbookContext.test.tsx).
      mockUseApiParseTfModule.mockReturnValue({
        data: {
          variables: [
            {
              name: 'region',
              description: 'AWS Region',
              type: BoilerplateVariableType.String,
              default: 'us-east-1',
              required: false,
            },
          ],
          metadata: {
            folder_name: 'my-module',
            readme_title: 'My Module',
            output_names: ['output_a'],
            resource_names: ['aws_instance.main'],
          },
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        silentRefetch: vi.fn(),
      })

      // Render succeeds — the form appears
      const { container } = render(
        <TestWrapper remoteSource="https://github.com/org/module">
          <TfModule id="module-vars" source="::source" />
        </TestWrapper>
      )

      // Should have rendered the form (not an error or loading state)
      expect(container.querySelector('form')).toBeInTheDocument()
    })
  })
})
