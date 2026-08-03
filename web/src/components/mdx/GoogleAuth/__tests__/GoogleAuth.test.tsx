import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import { ApiProvider } from '@/contexts/ApiContext'

/**
 * Integration coverage for the whole `<GoogleAuth>` block: the real component,
 * the real `useGoogleAuth` state machine, and the real sub-components. The only
 * thing faked is the IPC surface behind `useApi()` — the true boundary — plus
 * session readiness, which is ambient state rather than behaviour under test.
 *
 * Each of the three tabs gets a happy path, detection gets its confirm gate, a
 * rejected credential proves runtime errors render INLINE (never via
 * `reportError`), and the configuration errors (missing/duplicate id, two block
 * sources) prove the opposite.
 */

vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({ isReady: true }),
}))

import GoogleAuth from '../GoogleAuth'

type InvokeImpl = (channel: string, args?: Record<string, unknown>) => unknown

type Api = Parameters<typeof ApiProvider>[0]['api']

let currentApi: Api
let invoke: ReturnType<typeof vi.fn>

function installApi(impl: InvokeImpl) {
  invoke = vi.fn(async (channel: string, args?: Record<string, unknown>) => {
    const result = impl(channel, args)
    // The block probes `google:oauth-available` on mount so the Google Sign-In
    // tab can render disabled on first paint. Default it to "configured" so
    // only the tests that care about an unconfigured build have to say so.
    if (channel === 'google:oauth-available' && Object.keys((result ?? {}) as object).length === 0) {
      return { available: true }
    }
    return result
  })
  currentApi = { invoke, on: () => () => {}, once: () => {} } as unknown as Api
  return invoke
}

/** Calls to one channel, ignoring the mount-time capability probe. */
function callsTo(channel: string): unknown[][] {
  return invoke.mock.calls.filter((call) => call[0] === channel)
}

function renderBlock(children: ReactNode) {
  return render(
    <TestWrapper>
      <ApiProvider api={currentApi}>{children}</ApiProvider>
    </TestWrapper>,
  )
}

const SA_KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'key-project',
  client_email: 'sa@key-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nzzz\n-----END PRIVATE KEY-----\n',
})

/** Nothing ambient to find — the block falls through to the manual tabs. */
const NO_CREDENTIALS: InvokeImpl = (channel) =>
  channel === 'google:env-credentials' ? { found: false } : {}

beforeEach(() => {
  installApi(NO_CREDENTIALS)
})

// ---------------------------------------------------------------------------
// Rendering + configuration errors
// ---------------------------------------------------------------------------

describe('GoogleAuth — rendering', () => {
  it('renders the default title and all three auth tabs once detection settles', async () => {
    renderBlock(<GoogleAuth id="gcp" />)

    expect(screen.getByTestId('gcp')).toBeInTheDocument()
    expect(screen.getByText('Google Cloud Authentication')).toBeInTheDocument()
    // Detection runs first and is announced while it is in flight.
    expect(screen.getByText('Checking for existing credentials...')).toBeInTheDocument()

    expect(await screen.findByRole('button', { name: 'Service Account Key' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Google Sign-In' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'gcloud Config' })).toBeInTheDocument()
    // Service-account key is the default tab.
    expect(screen.getByLabelText('Service account key JSON')).toBeInTheDocument()
    expect(screen.getByTestId('gcp').querySelector('[data-testid^="error-"]')).toBeNull()
  })

  it('renders a custom title and description', async () => {
    renderBlock(<GoogleAuth id="gcp" title="Connect to GCP" description="Authenticate first." />)

    expect(screen.getByText('Connect to GCP')).toBeInTheDocument()
    expect(screen.getByText('Authenticate first.')).toBeInTheDocument()
    await screen.findByRole('button', { name: 'Service Account Key' })
  })

  it('shows a configuration error for a missing id', () => {
    renderBlock(<GoogleAuth id="" />)
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it('shows a configuration error for a duplicate id', async () => {
    renderBlock(
      <>
        <GoogleAuth id="dup" />
        <GoogleAuth id="dup" />
      </>,
    )

    // Both instances flag the collision — neither can claim the id.
    expect(await screen.findAllByText('Duplicate Component ID:')).not.toHaveLength(0)
    expect(screen.getAllByText('<GoogleAuth>')).not.toHaveLength(0)
    expect(screen.queryByLabelText('Service account key JSON')).toBeNull()
  })

  it('shows a configuration error for more than one { block } detection source', async () => {
    renderBlock(
      <GoogleAuth id="gcp" detectCredentials={[{ block: 'one' }, { block: 'two' }]} />,
    )

    expect(await screen.findByText('Invalid Configuration:')).toBeInTheDocument()
    // The card early-returns: no auth UI at all.
    expect(screen.queryByRole('button', { name: 'Service Account Key' })).toBeNull()
  })

  it('detectCredentials={false} skips detection entirely and shows the tabs immediately', () => {
    installApi(NO_CREDENTIALS)
    renderBlock(<GoogleAuth id="gcp" detectCredentials={false} />)

    expect(screen.getByRole('button', { name: 'Service Account Key' })).toBeInTheDocument()
    expect(screen.queryByText('Checking for existing credentials...')).toBeNull()
    // Nothing is probed for credentials. (The OAuth capability probe is not a
    // credential read — it only asks whether this build has a client id.)
    expect(callsTo('google:env-credentials')).toHaveLength(0)
    expect(callsTo('google:validate-credentials')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tab 1 — service account key
// ---------------------------------------------------------------------------

describe('GoogleAuth — service account tab', () => {
  it('authenticates with a pasted key and shows the success card', async () => {
    installApi((channel) => {
      if (channel === 'google:env-credentials') return { found: false }
      if (channel === 'google:validate-credentials') {
        return {
          valid: true,
          account: {
            principal: 'sa@key-project.iam.gserviceaccount.com',
            accountType: 'service_account',
          },
          projectId: 'proj-x',
          projectName: 'Project X',
          credentialType: 'service_account',
          credentialsPath: '/tmp/runbooks-gcp-a/adc.json',
        }
      }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    renderBlock(<GoogleAuth id="gcp" project="proj-x" />)

    const keyField = await screen.findByLabelText('Service account key JSON')
    fireEvent.change(keyField, { target: { value: SA_KEY } })
    fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }))

    expect(await screen.findByText('✓ Authenticated to Google Cloud')).toBeInTheDocument()
    expect(screen.getByText('sa@key-project.iam.gserviceaccount.com')).toBeInTheDocument()
    expect(screen.getByText('Service account key')).toBeInTheDocument()
    // The credentials PATH is published (it is not a secret); the contents never are.
    expect(
      screen.getByText('GOOGLE_APPLICATION_CREDENTIALS=/tmp/runbooks-gcp-a/adc.json'),
    ).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('google:validate-credentials', {
      blockId: 'gcp',
      keyJson: SA_KEY,
      projectId: 'proj-x',
      registerSession: true,
    })
  })

  it('renders a rejected key inline as a runtime error, not a reported one', async () => {
    installApi((channel) => {
      if (channel === 'google:env-credentials') return { found: false }
      if (channel === 'google:validate-credentials') {
        return { valid: false, error: 'Not a service account key (expected type: service_account)' }
      }
      return {}
    })

    renderBlock(<GoogleAuth id="gcp" />)

    const keyField = await screen.findByLabelText('Service account key JSON')
    fireEvent.change(keyField, { target: { value: '{"type":"authorized_user"}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }))

    expect(await screen.findByText('Authentication failed:')).toBeInTheDocument()
    expect(
      screen.getByText(/Not a service account key \(expected type: service_account\)/),
    ).toBeInTheDocument()
    // Runtime failures never escalate to the configuration-error channel, and
    // the form stays on screen so the user can correct the key.
    const block = screen.getByTestId('gcp')
    expect(block.querySelector('[data-testid^="error-"]')).toBeNull()
    expect(screen.getByLabelText('Service account key JSON')).toBeInTheDocument()
  })

  it('routes to the project picker when the key sees more than one project', async () => {
    installApi((channel) => {
      if (channel === 'google:env-credentials') return { found: false }
      if (channel === 'google:validate-credentials') {
        return {
          valid: true,
          account: {
            principal: 'sa@key-project.iam.gserviceaccount.com',
            accountType: 'service_account',
          },
          credentialType: 'service_account',
          credentialsPath: '/tmp/runbooks-gcp-b/adc.json',
          projects: [
            { projectId: 'proj-one', displayName: 'Project One' },
            { projectId: 'proj-two', displayName: 'Project Two' },
          ],
        }
      }
      if (channel === 'google:set-project') return { ok: true, projectName: 'Project Two' }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    renderBlock(<GoogleAuth id="gcp" />)

    const keyField = await screen.findByLabelText('Service account key JSON')
    fireEvent.change(keyField, { target: { value: SA_KEY } })
    fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }))

    expect(await screen.findByText('Select a Google Cloud project to continue:')).toBeInTheDocument()
    // The tabs are hidden for the duration of the sub-selection.
    expect(screen.queryByRole('button', { name: 'Service Account Key' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Project Two/ }))

    expect(await screen.findByText('✓ Authenticated to Google Cloud')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('google:set-project', {
      blockId: 'gcp',
      projectId: 'proj-two',
    })
  })
})

// ---------------------------------------------------------------------------
// Tab 2 — Google sign-in
// ---------------------------------------------------------------------------

describe('GoogleAuth — Google sign-in tab', () => {
  it('starts the loopback flow, shows the browser handoff, and completes', async () => {
    let pollCount = 0
    installApi((channel) => {
      if (channel === 'google:env-credentials') return { found: false }
      if (channel === 'google:oauth-start') {
        return {
          flowId: 'flow-1',
          authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
          redirectUri: 'http://127.0.0.1:53211/oauth2callback',
        }
      }
      if (channel === 'google:oauth-poll') {
        pollCount += 1
        return {
          status: 'complete',
          account: { principal: 'dev@example.com', accountType: 'user' },
          credentialsPath: '/tmp/runbooks-gcp-c/adc.json',
          projects: [{ projectId: 'proj-solo', displayName: 'Solo Project' }],
        }
      }
      if (channel === 'google:set-project') return { ok: true, projectName: 'Solo Project' }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    renderBlock(<GoogleAuth id="gcp" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Google Sign-In' }))
    expect(screen.getByRole('button', { name: /Sign in with Google/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/ }))

    expect(await screen.findByText('✓ Authenticated to Google Cloud')).toBeInTheDocument()
    expect(screen.getByText('dev@example.com')).toBeInTheDocument()
    expect(screen.getByText('User credentials (ADC)')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('native:open-external', {
      url: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
    })
    expect(pollCount).toBeGreaterThan(0)
  })

  it('disables the tab on FIRST PAINT when the build has no OAuth client', async () => {
    installApi((channel) => {
      if (channel === 'google:env-credentials') return { found: false }
      if (channel === 'google:oauth-available') return { available: false }
      return {}
    })

    renderBlock(<GoogleAuth id="gcp" />)

    // The mount-time capability probe is what makes this reachable: without it
    // the tab renders fully enabled and the user only learns otherwise after a
    // click that was always going to fail.
    const tab = await screen.findByRole('button', { name: /Google Sign-In/ })
    await waitFor(() => expect(tab).toBeDisabled())
    expect(screen.getByText('(unavailable)')).toBeInTheDocument()

    // The tab cannot be entered, so there is no sign-in button to press.
    fireEvent.click(tab)
    expect(screen.queryByRole('button', { name: /Sign in with Google/ })).toBeNull()
    expect(callsTo('google:oauth-start')).toHaveLength(0)
  })

  it('falls back to disabling the tab when oauth-start reports it is not configured', async () => {
    // The probe says the build is fine, but the flow is refused at start time.
    installApi((channel) => {
      if (channel === 'google:env-credentials') return { found: false }
      if (channel === 'google:oauth-start') {
        return { error: 'OAuth login is not configured for this build' }
      }
      return {}
    })

    renderBlock(<GoogleAuth id="gcp" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Google Sign-In' }))
    fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/ }))

    // The copy lands twice on purpose: the inline failure line and the panel
    // that points at the two tabs that still work.
    expect(
      await screen.findAllByText(/OAuth login is not configured for this build/),
    ).not.toHaveLength(0)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Google Sign-In/ })).toBeDisabled(),
    )
    expect(screen.queryByRole('button', { name: /Sign in with Google/ })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tab 3 — gcloud configuration
// ---------------------------------------------------------------------------

describe('GoogleAuth — gcloud tab', () => {
  const listing = {
    configurations: [
      {
        name: 'default',
        isActive: true,
        account: 'dev@example.com',
        project: 'proj-a',
        authType: 'adc-user',
      },
      { name: 'staging', isActive: false, project: 'proj-s', authType: 'config-only' },
    ],
    activeConfiguration: 'default',
    configRoot: '/home/u/.config/gcloud',
    adc: {
      path: '/home/u/.config/gcloud/application_default_credentials.json',
      type: 'authorized_user',
      clientEmail: 'dev@example.com',
    },
  }

  it('lists configurations on tab entry and authenticates with the selected one', async () => {
    installApi((channel) => {
      if (channel === 'google:env-credentials') return { found: false }
      if (channel === 'google:gcloud-configurations') return listing
      if (channel === 'google:gcloud-auth') {
        return {
          valid: true,
          account: { principal: 'dev@example.com', accountType: 'user' },
          projectId: 'proj-a',
          credentialsPath: '/home/u/.config/gcloud/application_default_credentials.json',
        }
      }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    renderBlock(<GoogleAuth id="gcp" />)

    fireEvent.click(await screen.findByRole('button', { name: 'gcloud Config' }))

    // The listing is a pure disk read in MAIN; no gcloud binary is invoked.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('google:gcloud-configurations', {}))
    expect(await screen.findByText('default')).toBeInTheDocument()
    // A configuration with no ADC is listed but not selectable.
    const staging = screen.getByText('staging').closest('button')!
    expect(staging).toBeDisabled()
    expect(screen.getByText('No ADC')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Use Selected Configuration' }))

    expect(await screen.findByText('✓ Authenticated to Google Cloud')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('google:gcloud-auth', {
      blockId: 'gcp',
      configuration: 'default',
      projectId: 'proj-a',
    })
  })
})

// ---------------------------------------------------------------------------
// Detection + confirmation gate
// ---------------------------------------------------------------------------

describe('GoogleAuth — credential detection', () => {
  const detected = {
    found: true,
    valid: true,
    projectId: 'proj-a',
    projectName: 'Project A',
    account: { principal: 'dev@example.com', accountType: 'user' },
    credentialType: 'authorized_user',
    envVar: 'GOOGLE_APPLICATION_CREDENTIALS',
  }

  it('prompts for confirmation before using detected credentials', async () => {
    installApi((channel) => {
      if (channel === 'google:env-credentials') return detected
      if (channel === 'google:env-credentials-confirm') {
        return {
          valid: true,
          account: { principal: 'dev@example.com', accountType: 'user' },
          projectId: 'proj-a',
          credentialsPath: '/tmp/runbooks-gcp-d/adc.json',
          credentialType: 'authorized_user',
        }
      }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={['env']} />)

    expect(await screen.findByText('Google Cloud Credentials Detected')).toBeInTheDocument()
    expect(screen.getByText('Source: Environment Variables')).toBeInTheDocument()
    expect(screen.getByText('GOOGLE_APPLICATION_CREDENTIALS')).toBeInTheDocument()
    // Nothing has been used yet — the confirm gate is what makes it this block's.
    expect(screen.queryByText('✓ Authenticated to Google Cloud')).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('google:env-credentials-confirm', expect.anything())

    fireEvent.click(screen.getByRole('button', { name: 'Use These Credentials' }))

    expect(await screen.findByText('✓ Authenticated to Google Cloud')).toBeInTheDocument()
    expect(screen.getByText('Environment Variables')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('google:env-credentials-confirm', {
      blockId: 'gcp',
      source: 'env',
      projectId: 'proj-a',
    })
  })

  it('"Use Different Credentials" falls through to the manual tabs', async () => {
    installApi((channel) => (channel === 'google:env-credentials' ? detected : {}))

    renderBlock(<GoogleAuth id="gcp" detectCredentials={['env']} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Use Different Credentials' }))

    expect(await screen.findByRole('button', { name: 'Service Account Key' })).toBeInTheDocument()
    expect(screen.queryByText('Google Cloud Credentials Detected')).toBeNull()
  })

  it('warns inline when the ambient credentials are found but invalid', async () => {
    installApi((channel) =>
      channel === 'google:env-credentials' ? { found: true, valid: false } : {},
    )

    renderBlock(<GoogleAuth id="gcp" detectCredentials={['env']} />)

    expect(await screen.findByText('Invalid credentials detected:')).toBeInTheDocument()
    expect(
      screen.getByText(/Google Cloud credentials in the environment are invalid or expired/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Service Account Key' })).toBeInTheDocument()
  })

  it('offers a detection retry from the manual form', async () => {
    installApi(NO_CREDENTIALS)
    renderBlock(<GoogleAuth id="gcp" detectCredentials={['env']} />)

    const retry = await screen.findByRole('button', { name: '← Try auto-detection again' })
    expect(callsTo('google:env-credentials')).toHaveLength(1)

    fireEvent.click(retry)

    await waitFor(() => expect(callsTo('google:env-credentials')).toHaveLength(2))
    expect(await screen.findByText('No credentials found')).toBeInTheDocument()
  })
})


// ---------------------------------------------------------------------------
// Required scopes on detected ADC
// ---------------------------------------------------------------------------

describe('GoogleAuth — required scopes', () => {
  const DIRECTORY = 'https://www.googleapis.com/auth/admin.directory.rolemanagement'
  const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform'
  const requiredScopes = [CLOUD_PLATFORM, DIRECTORY]

  const insufficient = {
    found: true,
    valid: false,
    insufficientScopes: true,
    missingScopes: [DIRECTORY],
    grantedScopes: [CLOUD_PLATFORM],
    projectId: 'proj-a',
    projectName: 'Project A',
    account: { principal: 'admin@example.com', accountType: 'user', scopes: [CLOUD_PLATFORM] },
    credentialType: 'authorized_user',
    envVar: 'GOOGLE_APPLICATION_CREDENTIALS',
  }

  it('shows the insufficient-scopes recovery card instead of Use These Credentials', async () => {
    installApi((channel, args) => {
      if (channel === 'google:env-credentials') {
        expect(args?.scopes).toEqual(requiredScopes)
        return insufficient
      }
      return {}
    })

    renderBlock(
      <GoogleAuth id="gcp" detectCredentials={['env']} scopes={requiredScopes} />,
    )

    expect(await screen.findByText('Credentials missing required scopes')).toBeInTheDocument()
    expect(screen.getByText(DIRECTORY)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use These Credentials' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in with required scopes' })).toBeInTheDocument()
  })

  it('starts Google Sign-In with the required scopes from the recovery card', async () => {
    installApi((channel) => {
      if (channel === 'google:env-credentials') return insufficient
      if (channel === 'google:oauth-start') {
        return {
          flowId: 'flow-scopes',
          authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=scopes',
        }
      }
      if (channel === 'google:oauth-poll') return { status: 'pending' }
      return {}
    })

    renderBlock(
      <GoogleAuth id="gcp" detectCredentials={['env']} scopes={requiredScopes} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with required scopes' }))

    await waitFor(() => expect(callsTo('google:oauth-start')).toHaveLength(1))
    expect(invoke).toHaveBeenCalledWith('google:oauth-start', { scopes: requiredScopes })
    expect(await screen.findByText(/Waiting for browser sign-in/i)).toBeInTheDocument()
  })

  it('shows the gcloud --scopes command when Sign-In is unavailable', async () => {
    installApi((channel) => {
      if (channel === 'google:oauth-available') return { available: false }
      if (channel === 'google:env-credentials') return insufficient
      return {}
    })

    renderBlock(
      <GoogleAuth id="gcp" detectCredentials={['env']} scopes={requiredScopes} />,
    )

    expect(await screen.findByText('Credentials missing required scopes')).toBeInTheDocument()
    expect(
      screen.getByText(
        `gcloud auth application-default login --scopes=${CLOUD_PLATFORM},${DIRECTORY}`,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in with required scopes' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Try auto-detection again' })).toBeInTheDocument()
  })

  it('does not enforce default scopes when the author omits the prop', async () => {
    installApi((channel, args) => {
      if (channel === 'google:env-credentials') {
        expect(args?.scopes).toBeUndefined()
        return {
          found: true,
          valid: true,
          projectId: 'proj-a',
          account: { principal: 'dev@example.com', accountType: 'user' },
          credentialType: 'authorized_user',
        }
      }
      return {}
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={['env']} />)

    expect(await screen.findByText('Google Cloud Credentials Detected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use These Credentials' })).toBeInTheDocument()
  })
})
