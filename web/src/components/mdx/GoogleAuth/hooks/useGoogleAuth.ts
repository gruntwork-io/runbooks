import { useState, useCallback, useRef, useEffect } from "react"
import { useApi } from "@/contexts/ApiContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSession } from "@/contexts/useSession"
import { normalizeBlockId } from "@/lib/utils"
import type {
  AdcInfo,
  DetectedGoogleCredentials,
  GcloudConfigInfo,
  GoogleAccountInfo,
  GoogleAuthMethod,
  GoogleAuthStatus,
  GoogleCredentialSource,
  GoogleCredentialType,
  GoogleDetectionStatus,
  GoogleProjectInfo,
} from "../types"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 2s x 150 = 5 minutes, matching the layer's OAUTH_FLOW_TTL_MS. */
const OAUTH_POLL_INTERVAL_MS = 2000
const OAUTH_POLL_MAX_ATTEMPTS = 150

/** How long the "no credentials found" retry hint stays on screen. */
const RETRY_MESSAGE_TIMEOUT_MS = 3000

/**
 * `google:oauth-start` reports a build without a registered OAuth client with
 * this copy (plan §5.2). The tab is normally already disabled by the
 * `google:oauth-available` probe below; this pattern is the fallback for a
 * build whose client id is present but rejected at start time.
 */
const OAUTH_NOT_CONFIGURED_PATTERN = /not configured/i

/**
 * Copy for a credential that authenticated but has no project to work against.
 * Publishing blank `GOOGLE_CLOUD_PROJECT` under `__AUTHENTICATED: 'true'` and
 * calling it success is how a runbook ends up with every later command failing
 * on "The project property must be set".
 */
const NO_PROJECT_WARNING =
  'Authenticated, but no Google Cloud project is set. Commands that need a project will fail until one is chosen — set the block\'s `project` prop, set `core/project` in your gcloud configuration, or use "Change project".'

// ---------------------------------------------------------------------------
// Local structural types
//
// These mirror the metadata-only shapes returned by the `google:*` channels.
// They are declared locally (rather than imported from electron/shared) so the
// renderer keeps a single source of truth for its own view models; the IPC
// results are structurally compatible.
// ---------------------------------------------------------------------------

/** The subset of `google:env-credentials` we turn into a detection card. */
interface EnvDetectionPayload {
  projectId?: string
  projectName?: string
  account?: { principal: string; accountType: 'service_account' | 'user'; scopes?: string[] }
  credentialType?: GoogleCredentialType
  envVar?: string
  path?: string
  configuration?: string
  quotaProjectId?: string
  insufficientScopes?: boolean
  missingScopes?: string[]
  grantedScopes?: string[]
}

/** Result of one detection attempt against a single source. */
interface DetectionAttemptResult {
  success: boolean
  detected?: DetectedGoogleCredentials
  /** Advisory copy main attached to a SUCCESSFUL detection. */
  warning?: string
  /** A credential was present but did not validate — worth a warning chip. */
  foundButInvalid?: boolean
  error?: string
}

/** Identity metadata carried from a completed auth into project selection. */
interface PendingAccount {
  principal?: string
  accountType?: 'service_account' | 'user'
  credentialType?: GoogleCredentialType
  scopes?: string[]
  credentialsPath?: string
}

/** Everything needed to finish an authentication and publish block outputs. */
interface AuthCompletion extends PendingAccount {
  projectId: string
  projectName?: string
  region?: string
  zone?: string
  sessionEnvWarning?: string
}

// ---------------------------------------------------------------------------
// Public contract (plan §3) — the block component is built against this shape.
// ---------------------------------------------------------------------------

export interface UseGoogleAuthOptions {
  id: string
  project?: string
  scopes?: string[]
  oauthClientId?: string
  oauthClientSecret?: string
  oauthClientFile?: string
  defaultRegion?: string
  defaultZone?: string
  gcloudConfiguration?: string
  detectCredentials?: false | GoogleCredentialSource[]
}

export interface UseGoogleAuthReturn {
  // ---- Core state -----------------------------------------------------------
  authMethod: GoogleAuthMethod
  setAuthMethod: (m: GoogleAuthMethod) => void
  authStatus: GoogleAuthStatus
  errorMessage: string | null
  /** Project-access warning from google:check-project, or a sessionEnvWarning. */
  warningMessage: string | null
  accountInfo: GoogleAccountInfo | null

  // ---- Detection state ------------------------------------------------------
  detectionStatus: GoogleDetectionStatus
  detectedCredentials: DetectedGoogleCredentials | null
  detectionWarning: string | null
  waitingForBlockId: string | null
  retryFoundNothing: boolean
  clearRetryMessage: () => void

  // ---- Service-account tab --------------------------------------------------
  serviceAccountKey: string
  setServiceAccountKey: (v: string) => void
  showServiceAccountKey: boolean
  setShowServiceAccountKey: (v: boolean) => void
  /** Base name of a chosen key file. The renderer never holds its contents. */
  keyFileName: string | null
  /** Absolute path of a chosen key file — what MAIN reads and validates. */
  keyFilePath: string | null
  loadKeyFromFile: () => Promise<void>
  /** Free-text project override for the SA tab. Seeded from the `project` prop. */
  projectIdInput: string
  setProjectIdInput: (v: string) => void

  // ---- Region / zone (secondary) --------------------------------------------
  selectedRegion: string
  setSelectedRegion: (v: string) => void
  selectedZone: string
  setSelectedZone: (v: string) => void

  // ---- gcloud tab -----------------------------------------------------------
  gcloudConfigs: GcloudConfigInfo[]
  selectedConfig: GcloudConfigInfo | null
  setSelectedConfig: (c: GcloudConfigInfo) => void
  loadingConfigs: boolean
  configSearch: string
  setConfigSearch: (v: string) => void
  loadGcloudConfigs: () => Promise<void>
  /** Metadata for the well-known ADC file, or null when absent. */
  adcInfo: AdcInfo | null
  /** Resolved gcloud config root, for the "no configurations found at X" copy. */
  gcloudConfigRoot: string | null

  // ---- OAuth tab ------------------------------------------------------------
  /** Non-null while a loopback flow is live. Renders the "finish in the browser" card. */
  oauthFlowId: string | null
  oauthAuthUrl: string | null
  /**
   * True when neither the build default, author props/file, operator env, nor an
   * operator-picked Desktop client JSON can supply an OAuth client yet.
   */
  oauthUnavailable: boolean
  /**
   * Base name of a Desktop OAuth client JSON the operator chose in-session.
   * The renderer holds the path only — MAIN reads `installed.client_*`.
   */
  oauthClientFileName: string | null
  /** Absolute path of the operator-chosen Desktop OAuth client JSON. */
  oauthClientFilePath: string | null
  /** Opens the native file picker for a Console Desktop-app `client_secret_*.json`. */
  loadOAuthClientFromFile: () => Promise<void>
  /** Clears an operator-chosen client JSON so Sign-In falls back to props/env. */
  clearOAuthClientFile: () => void

  // ---- Project selection sub-flow -------------------------------------------
  projects: GoogleProjectInfo[]
  selectedProject: GoogleProjectInfo | null
  loadingProjects: boolean
  projectSearch: string
  setProjectSearch: (v: string) => void

  // ---- Handlers -------------------------------------------------------------
  handleServiceAccountSubmit: () => void
  handleOAuthLogin: () => Promise<void>
  handleCancelOAuth: () => void
  handleGcloudAuth: () => Promise<void>
  handleProjectSelect: (p: GoogleProjectInfo) => Promise<void>
  handleChangeProject: () => Promise<void>
  handleConfirmDetected: () => Promise<void>
  handleRejectDetected: () => void
  handleRetryDetection: () => void
  handleManualAuth: () => void
  /** Decline insufficient-scopes detection and start Google Sign-In with required scopes. */
  handleSignInWithRequiredScopes: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * State machine for the `<GoogleAuth>` block: three authentication tabs
 * (service-account key, Google sign-in, gcloud configuration), credential
 * auto-detection behind a confirmation gate, and project selection.
 *
 * Secret custody (plan §6): the renderer may SEND a user-pasted service-account
 * key, but MAIN owns every credential write — the session env, the materialised
 * credentials file, and the redaction registry. No `google:*` result carries
 * credential material, and this hook never calls `session:set-env`.
 *
 * Every error surfaced here is a RUNTIME error (invalid key, expired ADC, OAuth
 * denial, network failure) and renders inline via `errorMessage` /
 * `detectionWarning`. Configuration errors (duplicate id, more than one
 * `{ block: … }` source) are the block component's job via `reportError()`.
 */
export function useGoogleAuth({
  id,
  project,
  scopes,
  oauthClientId,
  oauthClientSecret,
  oauthClientFile,
  defaultRegion,
  defaultZone,
  gcloudConfiguration,
  detectCredentials = ['env', 'adc'],
}: UseGoogleAuthOptions): UseGoogleAuthReturn {
  const api = useApi()
  const { registerOutputs, blockOutputs } = useRunbookContext()
  const { isReady: sessionReady } = useSession()

  // ---- Core auth state ------------------------------------------------------
  const [authMethod, setAuthMethod] = useState<GoogleAuthMethod>('service_account')
  const [authStatus, setAuthStatus] = useState<GoogleAuthStatus>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [warningMessage, setWarningMessage] = useState<string | null>(null)
  const [accountInfo, setAccountInfo] = useState<GoogleAccountInfo | null>(null)

  // ---- Detection state ------------------------------------------------------
  const [detectionStatus, setDetectionStatus] = useState<GoogleDetectionStatus>(
    detectCredentials === false ? 'done' : 'pending'
  )
  const [detectedCredentials, setDetectedCredentials] = useState<DetectedGoogleCredentials | null>(null)
  const [detectionWarning, setDetectionWarning] = useState<string | null>(null)
  const [retryFoundNothing, setRetryFoundNothing] = useState(false)
  // Counter that re-arms the detection effect for "Try auto-detection again".
  const [detectionAttempt, setDetectionAttempt] = useState(0)
  const detectionAttemptedRef = useRef(false)
  // For block-based detection, which block we paused the walk on.
  const [waitingForBlockId, setWaitingForBlockId] = useState<string | null>(null)
  // Sources listed AFTER the block source we paused on. Detection resumes here
  // if the block eventually runs but cannot supply usable credentials.
  const remainingSourcesRef = useRef<GoogleCredentialSource[]>([])

  // ---- Service-account tab --------------------------------------------------
  const [serviceAccountKey, setServiceAccountKey] = useState('')
  const [showServiceAccountKey, setShowServiceAccountKey] = useState(false)
  // Absolute path of a key file the user chose. The renderer holds the PATH and
  // never the contents — MAIN reads and validates the file itself (D12).
  const [keyFilePath, setKeyFilePath] = useState<string | null>(null)
  const [keyFileName, setKeyFileName] = useState<string | null>(null)
  const [projectIdInput, setProjectIdInput] = useState(project ?? '')

  // ---- Region / zone (secondary) --------------------------------------------
  const [selectedRegion, setSelectedRegion] = useState(defaultRegion ?? '')
  const [selectedZone, setSelectedZone] = useState(defaultZone ?? '')

  // ---- gcloud tab -----------------------------------------------------------
  const [gcloudConfigs, setGcloudConfigs] = useState<GcloudConfigInfo[]>([])
  const [selectedConfig, setSelectedConfig] = useState<GcloudConfigInfo | null>(null)
  const [loadingConfigs, setLoadingConfigs] = useState(false)
  const [configSearch, setConfigSearch] = useState('')
  const [adcInfo, setAdcInfo] = useState<AdcInfo | null>(null)
  const [gcloudConfigRoot, setGcloudConfigRoot] = useState<string | null>(null)

  // ---- OAuth tab ------------------------------------------------------------
  const [oauthFlowId, setOauthFlowId] = useState<string | null>(null)
  const [oauthAuthUrl, setOauthAuthUrl] = useState<string | null>(null)
  // Seeded from a MAIN capability probe on mount (see the effect below), NOT
  // discovered after a failed click: an author who supplies their own client id
  // is available by definition and needs no round trip.
  const [oauthUnavailable, setOauthUnavailable] = useState(false)
  // Operator-chosen Desktop OAuth client JSON (path only — same custody rule as
  // the SA key picker). Author `oauthClientFile` wins when both are set.
  const [oauthClientFilePath, setOauthClientFilePath] = useState<string | null>(null)
  const [oauthClientFileName, setOauthClientFileName] = useState<string | null>(null)
  const oauthPollCancelledRef = useRef(false)
  const oauthPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Mirrors oauthFlowId so the unmount cleanup can cancel MAIN's loopback
  // listener without taking the state value as an effect dependency.
  const oauthFlowIdRef = useRef<string | null>(null)

  const effectiveOauthClientFile = oauthClientFile || oauthClientFilePath || undefined

  // ---- Project selection ----------------------------------------------------
  const [projects, setProjects] = useState<GoogleProjectInfo[]>([])
  const [selectedProject, setSelectedProject] = useState<GoogleProjectInfo | null>(null)
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [projectSearch, setProjectSearch] = useState('')

  // Credentials file MAIN materialised for the in-flight authentication. Held
  // across the `select_project` detour so the outputs published after the user
  // picks a project still name the right file.
  const pendingCredentialsPathRef = useRef<string | null>(null)

  // Region/zone the in-flight tab resolved, when they differ from the props —
  // the gcloud tab inherits `compute/region` and `compute/zone` from the chosen
  // configuration. Held across the `select_project` detour for the same reason
  // as the credentials path: the picker must not silently drop them.
  const pendingComputeRef = useRef<{ region?: string; zone?: string } | null>(null)

  // Auto-hide the "no credentials found" retry hint (mirrors AwsAuth).
  useEffect(() => {
    if (!retryFoundNothing) return
    const timer = setTimeout(() => setRetryFoundNothing(false), RETRY_MESSAGE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [retryFoundNothing])

  const clearRetryMessage = useCallback(() => setRetryFoundNothing(false), [])

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /** Accumulate advisory copy without clobbering an earlier warning. */
  const appendWarning = useCallback((warning?: string | null) => {
    if (!warning) return
    setWarningMessage((prev) => (prev && prev !== warning ? `${prev}; ${warning}` : warning))
  }, [])

  /**
   * Stop the OAuth poll loop and release MAIN's loopback listener. Every exit
   * path (cancel, re-auth, unmount) goes through here — an abandoned flow
   * otherwise holds a listening socket until its server-side TTL expires.
   */
  const stopOAuthPolling = useCallback((opts?: { cancelFlow?: boolean }) => {
    oauthPollCancelledRef.current = true
    if (oauthPollTimeoutRef.current) {
      clearTimeout(oauthPollTimeoutRef.current)
      oauthPollTimeoutRef.current = null
    }
    const flowId = oauthFlowIdRef.current
    oauthFlowIdRef.current = null
    if (flowId && opts?.cancelFlow !== false) {
      void api.invoke('google:oauth-cancel', { flowId }).catch(() => {
        /* the flow's TTL cleans it up regardless */
      })
    }
  }, [api])

  /**
   * Confirm the project is readable with the credential we just registered.
   * Advisory only — the analogue of AwsAuth's region check, never fatal.
   */
  const checkProjectStatus = useCallback(async (projectId: string) => {
    if (!projectId) return
    try {
      // blockId: MAIN checks against THIS block's credential, not whichever
      // GoogleAuth block authenticated most recently.
      const data = await api.invoke('google:check-project', { blockId: id, projectId })
      if (data.warning) {
        appendWarning(data.warning)
      }
    } catch (error) {
      console.error('Failed to check Google Cloud project status:', error)
    }
  }, [api, id, appendWarning])

  /**
   * Publish this block's outputs in ONE call. `registerOutputs` REPLACES the
   * whole values map, so a partial second write would wipe the rest (plan §7.2).
   * `GOOGLE_APPLICATION_CREDENTIALS` is a path, not a secret — publishing it is
   * what makes multi-project `googleAuthId` routing work.
   */
  /**
   * Withdraw this block's authentication contract, and drop the credential path
   * with it. Called at the START of every flow that can make MAIN materialise a
   * new credential file.
   *
   * MAIN supersedes the previous file during that IPC call, but these outputs
   * are what a `<Command googleAuthId>` actually injects, and they are not
   * rewritten until `completeAuthentication` — which on the OAuth tab in a
   * multi-project org waits for the user to pick a project. Leaving the old
   * values standing across that window let a step run against a path the app had
   * already replaced, while the card still read as green.
   *
   * `registerOutputs` REPLACES the whole values map, so the stale path goes with
   * the marker. `'false'` rather than an omitted key keeps the withdrawal
   * legible in the outputs inspector.
   */
  const invalidateBlockOutputs = useCallback(() => {
    registerOutputs(id, { __AUTHENTICATED: 'false' })
  }, [id, registerOutputs])

  const registerBlockOutputs = useCallback((result: AuthCompletion) => {
    registerOutputs(id, {
      GOOGLE_APPLICATION_CREDENTIALS: result.credentialsPath ?? '',
      // Bridges the gcloud CLI's own credential store to this same file — see
      // MAIN's buildGoogleSessionEnv. Blank for a bare access-token credential,
      // which has no file to bridge with.
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: result.credentialsPath ?? '',
      GOOGLE_CLOUD_PROJECT: result.projectId,
      CLOUDSDK_CORE_PROJECT: result.projectId,
      GOOGLE_PROJECT: result.projectId,
      CLOUDSDK_CORE_ACCOUNT: result.principal ?? '',
      GOOGLE_CLOUD_REGION: result.region ?? '',
      CLOUDSDK_COMPUTE_REGION: result.region ?? '',
      GOOGLE_REGION: result.region ?? '',
      CLOUDSDK_COMPUTE_ZONE: result.zone ?? '',
      GOOGLE_ZONE: result.zone ?? '',
      GOOGLE_AUTH_TYPE: result.credentialType ?? '',
      __AUTHENTICATED: 'true',
    })

    // The path above is now the one steps will use, so whatever it superseded is
    // finally safe for MAIN to zero. Fire-and-forget: this is key-material
    // hygiene, never a precondition for the block being usable, and MAIN's
    // will-quit sweep is the backstop if it never lands.
    void api
      .invoke('google:credential-committed', {
        blockId: id,
        ...(result.credentialsPath ? { credentialsPath: result.credentialsPath } : {}),
      })
      .catch(() => {
        /* superseded files fall through to the will-quit sweep */
      })
  }, [api, id, registerOutputs])

  /**
   * The single success epilogue: every tab and the detection-confirm path end
   * here. MAIN has already written the session env by this point; the renderer
   * only records what happened and publishes the outputs.
   */
  const completeAuthentication = useCallback(async (result: AuthCompletion) => {
    if (result.credentialsPath) {
      pendingCredentialsPathRef.current = result.credentialsPath
    }
    const credentialsPath = result.credentialsPath ?? pendingCredentialsPathRef.current ?? undefined
    // The select_project detour is over; nothing should inherit its compute
    // defaults on a later authentication.
    pendingComputeRef.current = null

    setAccountInfo({
      ...(result.projectId ? { projectId: result.projectId } : {}),
      ...(result.projectName ? { projectName: result.projectName } : {}),
      ...(result.principal ? { principal: result.principal } : {}),
      ...(result.accountType ? { accountType: result.accountType } : {}),
      ...(result.credentialType ? { credentialType: result.credentialType } : {}),
      ...(result.scopes && result.scopes.length > 0 ? { scopes: result.scopes } : {}),
      ...(credentialsPath ? { credentialsPath } : {}),
    })

    registerBlockOutputs({ ...result, credentialsPath })

    setAuthStatus('authenticated')
    setDetectionStatus('done')
    setErrorMessage(null)
    appendWarning(result.sessionEnvWarning)

    // A credential can authenticate without resolving a project (a gcloud
    // configuration with no `core/project`, an authorized_user document with no
    // quota project, a principal that cannot enumerate projects). The outputs
    // are still published — the credential is real — but the success card has
    // to say the project is missing, or every later `gcloud`/`terraform` call
    // fails on "The project property must be set" with nothing to point at.
    if (!result.projectId) {
      appendWarning(NO_PROJECT_WARNING)
    }

    await checkProjectStatus(result.projectId)
  }, [registerBlockOutputs, appendWarning, checkProjectStatus])

  /** Region/zone actually in force: the tab's picker wins over the props. */
  const effectiveRegion = selectedRegion || defaultRegion || ''
  const effectiveZone = selectedZone || defaultZone || ''

  /**
   * Pin a project (picker click, single-project auto-select, or the `project`
   * prop after an OAuth login). MAIN owns the session-env write.
   */
  const selectProject = useCallback(async (
    projectInfo: GoogleProjectInfo,
    account?: PendingAccount,
    /** Region/zone the calling tab resolved, when they differ from the props. */
    compute?: { region?: string; zone?: string },
  ) => {
    const region = compute?.region ?? pendingComputeRef.current?.region ?? effectiveRegion
    const zone = compute?.zone ?? pendingComputeRef.current?.zone ?? effectiveZone

    setSelectedProject(projectInfo)
    setAuthStatus('authenticating')
    setErrorMessage(null)

    try {
      const data = await api.invoke('google:set-project', {
        blockId: id,
        projectId: projectInfo.projectId,
        ...(region ? { region } : {}),
        ...(zone ? { zone } : {}),
      })

      if (!data.ok) {
        setAuthStatus('failed')
        setErrorMessage(data.error || `Failed to select project "${projectInfo.projectId}"`)
        return
      }

      const identity: PendingAccount = account ?? {
        ...(accountInfo?.principal ? { principal: accountInfo.principal } : {}),
        ...(accountInfo?.accountType ? { accountType: accountInfo.accountType } : {}),
        ...(accountInfo?.credentialType ? { credentialType: accountInfo.credentialType } : {}),
        ...(accountInfo?.scopes ? { scopes: accountInfo.scopes } : {}),
        ...(accountInfo?.credentialsPath ? { credentialsPath: accountInfo.credentialsPath } : {}),
      }

      await completeAuthentication({
        ...identity,
        projectId: projectInfo.projectId,
        projectName: data.projectName || projectInfo.displayName,
        region,
        zone,
        ...(data.sessionEnvWarning ? { sessionEnvWarning: data.sessionEnvWarning } : {}),
      })
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to select project')
    }
  }, [api, id, effectiveRegion, effectiveZone, accountInfo, completeAuthentication])

  /** Fetch the projects visible to the current credential. */
  const loadProjects = useCallback(async () => {
    setLoadingProjects(true)
    try {
      // A LIVE loopback flow resolves main-side by flowId; after completion the
      // session env carries the credential and no handle is needed.
      const data = await api.invoke('google:projects', {
        blockId: id,
        ...(oauthFlowIdRef.current ? { flowId: oauthFlowIdRef.current } : {}),
      })
      setProjects((data.projects ?? []) as GoogleProjectInfo[])
      if (data.error) {
        setErrorMessage(data.error)
      }
    } catch (error) {
      console.error('Failed to load Google Cloud projects:', error)
      setProjects([])
    } finally {
      setLoadingProjects(false)
    }
  }, [api, id])

  // ---------------------------------------------------------------------------
  // Detection
  // ---------------------------------------------------------------------------

  /**
   * Read Google credentials out of a referenced block's outputs. Accepts a
   * credentials path, an inline credentials JSON, or a bare access token, in
   * that order; the project falls back to the block's project vars and finally
   * to the `project` prop.
   */
  const getBlockCredentials = useCallback((blockId: string): {
    found: boolean
    creds?: { keyPath?: string; keyJson?: string; accessToken?: string; projectId?: string }
    credentialType?: GoogleCredentialType
    error?: string
  } => {
    const normalizedId = normalizeBlockId(blockId)
    const outputs = blockOutputs[normalizedId]?.values

    if (!outputs) {
      return { found: false, error: `Block "${blockId}" has not been executed yet or has no outputs` }
    }

    const projectId =
      outputs.CLOUDSDK_CORE_PROJECT ||
      outputs.GOOGLE_CLOUD_PROJECT ||
      outputs.GOOGLE_PROJECT ||
      project ||
      undefined

    const keyPath = outputs.GOOGLE_APPLICATION_CREDENTIALS
    if (keyPath) {
      return { found: true, creds: { keyPath, ...(projectId ? { projectId } : {}) }, credentialType: 'service_account' }
    }

    const keyJson = outputs.GOOGLE_CREDENTIALS
    if (keyJson) {
      return { found: true, creds: { keyJson, ...(projectId ? { projectId } : {}) }, credentialType: 'service_account' }
    }

    const accessToken = outputs.GOOGLE_OAUTH_ACCESS_TOKEN || outputs.CLOUDSDK_AUTH_ACCESS_TOKEN
    if (accessToken) {
      return { found: true, creds: { accessToken, ...(projectId ? { projectId } : {}) }, credentialType: 'access_token' }
    }

    return {
      found: false,
      error: `Block "${blockId}" did not output GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CREDENTIALS, or an access token`,
    }
  }, [blockOutputs, project])

  /** Turn a `google:env-credentials` payload into a confirmation card. */
  const toDetectedCredentials = useCallback((
    data: EnvDetectionPayload,
    source: 'env' | 'adc' | 'gcloud',
    envPrefix?: string,
  ): DetectedGoogleCredentials => ({
    projectId: data.projectId ?? '',
    ...(data.projectName ? { projectName: data.projectName } : {}),
    principal: data.account?.principal ?? '',
    credentialType: data.credentialType ?? 'authorized_user',
    source,
    ...(data.quotaProjectId ? { quotaProjectId: data.quotaProjectId } : {}),
    ...(data.envVar ? { envVar: data.envVar } : {}),
    ...(envPrefix ? { envPrefix } : {}),
    ...(data.path ? { path: data.path } : {}),
    ...(data.configuration ? { configuration: data.configuration } : {}),
  }), [])

  /**
   * READ-ONLY detection against the environment, the well-known ADC file, or
   * the active gcloud configuration. Nothing is written to the session and no
   * outputs are registered until the user confirms (plan §8.3).
   */
  const tryEnvCredentials = useCallback(async (options?: {
    source?: 'env' | 'adc' | 'gcloud'
    prefix?: string
  }): Promise<DetectionAttemptResult> => {
    const source = options?.source ?? 'env'
    try {
      const data = await api.invoke('google:env-credentials', {
        ...(options?.prefix ? { prefix: options.prefix } : {}),
        ...(project ? { defaultProject: project } : {}),
        source,
        ...(scopes && scopes.length > 0 ? { scopes } : {}),
      })

      if (!data.found) {
        return { success: false, ...(data.error ? { error: data.error } : {}) }
      }

      // Valid identity but missing author-required scopes — stop walking sources
      // and show recovery rather than silently trying the next credential.
      if (data.insufficientScopes && data.missingScopes && data.missingScopes.length > 0) {
        return {
          success: true,
          detected: {
            ...toDetectedCredentials(data, source, options?.prefix),
            missingScopes: data.missingScopes,
            ...(data.grantedScopes ? { grantedScopes: data.grantedScopes } : {}),
          },
        }
      }

      if (!data.valid) {
        return { success: false, foundButInvalid: true, ...(data.error ? { error: data.error } : {}) }
      }

      return {
        success: true,
        detected: toDetectedCredentials(data, source, options?.prefix),
        ...(data.warning ? { warning: data.warning } : {}),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check Google Cloud credentials',
      }
    }
  }, [api, project, scopes, toDetectedCredentials])

  /**
   * READ-ONLY validation of credentials found in another block's outputs.
   * `registerSession: false` keeps this a probe — confirmation is what makes
   * the credential this block's.
   */
  const tryBlockCredentials = useCallback(async (blockId: string): Promise<DetectionAttemptResult> => {
    const result = getBlockCredentials(blockId)

    if (!result.found || !result.creds) {
      return { success: false, error: result.error || 'Could not read Google Cloud credentials from block' }
    }

    try {
      const data = await api.invoke('google:validate-credentials', {
        blockId: id,
        ...result.creds,
        registerSession: false,
        ...(scopes && scopes.length > 0 ? { scopes } : {}),
      })

      if (data.insufficientScopes && data.missingScopes && data.missingScopes.length > 0) {
        return {
          success: true,
          detected: {
            projectId: data.projectId ?? result.creds.projectId ?? '',
            ...(data.projectName ? { projectName: data.projectName } : {}),
            principal: data.account?.principal ?? '',
            credentialType: data.credentialType ?? result.credentialType ?? 'service_account',
            source: 'block',
            missingScopes: data.missingScopes,
            ...(data.grantedScopes ? { grantedScopes: data.grantedScopes } : {}),
          },
        }
      }

      if (!data.valid) {
        return { success: false, error: data.error || 'Block credentials are invalid' }
      }

      return {
        success: true,
        detected: {
          projectId: data.projectId ?? result.creds.projectId ?? '',
          ...(data.projectName ? { projectName: data.projectName } : {}),
          principal: data.account?.principal ?? '',
          credentialType: data.credentialType ?? result.credentialType ?? 'service_account',
          source: 'block',
        },
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to validate block credentials',
      }
    }
  }, [api, id, scopes, getBlockCredentials])

  /**
   * Walk the author's credential sources in order, stopping at the first
   * success. A block source that has NOT executed pauses the walk rather than
   * skipping ahead — the author's ordering is the priority order.
   */
  const trySourcesInOrder = useCallback(async (
    sources: GoogleCredentialSource[],
    isRetry: boolean,
  ) => {
    const warnings: string[] = []

    const succeed = (result: DetectionAttemptResult) => {
      setDetectedCredentials(result.detected!)
      if (result.warning) {
        setDetectionWarning(result.warning)
      }
      setDetectionStatus('detected')
    }

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]

      // 'env' — the unprefixed Google credential env vars
      if (source === 'env') {
        const result = await tryEnvCredentials({ source: 'env' })
        if (result.success && result.detected) {
          succeed(result)
          return
        }
        if (result.foundButInvalid) {
          warnings.push('Google Cloud credentials in the environment are invalid or expired')
        }
      }
      // 'adc' — the well-known application_default_credentials.json
      else if (source === 'adc') {
        const result = await tryEnvCredentials({ source: 'adc' })
        if (result.success && result.detected) {
          succeed(result)
          return
        }
        if (result.foundButInvalid) {
          warnings.push('Application Default Credentials are invalid or expired')
        }
      }
      // 'gcloud' — the ACTIVE gcloud configuration
      else if (source === 'gcloud') {
        const result = await tryEnvCredentials({ source: 'gcloud' })
        if (result.success && result.detected) {
          succeed(result)
          return
        }
        if (result.foundButInvalid) {
          warnings.push("The active gcloud configuration's credentials are invalid or expired")
        }
      }
      // { env: { prefix: 'PREFIX_' } } — prefixed env vars
      else if (typeof source === 'object' && 'env' in source) {
        const prefix = source.env?.prefix
        const result = await tryEnvCredentials({ source: 'env', ...(prefix ? { prefix } : {}) })
        if (result.success && result.detected) {
          succeed(result)
          return
        }
        if (result.foundButInvalid) {
          warnings.push(`${prefix ?? ''}Google Cloud credentials are invalid or expired`)
        }
      }
      // { block: 'id' } — another block's outputs
      else if (typeof source === 'object' && 'block' in source) {
        const result = await tryBlockCredentials(source.block)
        if (result.success && result.detected) {
          succeed(result)
          return
        }
        // "Has it executed?" is `values !== undefined` — `found: false` alone
        // conflates "never ran" with "ran, but produced nothing usable".
        const normalizedBlockId = normalizeBlockId(source.block)
        const blockHasExecuted = blockOutputs[normalizedBlockId]?.values !== undefined
        if (!blockHasExecuted) {
          remainingSourcesRef.current = sources.slice(i + 1)
          setWaitingForBlockId(source.block)
          return
        }
        // Executed but unusable — fall through to the next source.
      }
    }

    if (warnings.length > 0) {
      setDetectionWarning(warnings.join('; '))
    }
    if (isRetry) {
      setRetryFoundNothing(true)
    }
    setDetectionStatus('done')
  }, [tryEnvCredentials, tryBlockCredentials, blockOutputs])

  // Effect #1 — run detection once the session is ready.
  useEffect(() => {
    if (detectCredentials === false || detectionAttemptedRef.current) {
      return
    }
    if (!sessionReady) {
      return
    }

    detectionAttemptedRef.current = true

    // MDX authors must write detectCredentials={false}; the string "false"
    // would arrive truthy. Anything that is neither `false` nor an array is
    // treated as "no sources" rather than iterated as a string.
    void trySourcesInOrder(Array.isArray(detectCredentials) ? detectCredentials : [], detectionAttempt > 0)
  }, [detectCredentials, sessionReady, trySourcesInOrder, detectionAttempt])

  // Effect #2 — resume the walk once the block we paused on has run.
  useEffect(() => {
    if (!waitingForBlockId || detectionStatus === 'detected' || authStatus === 'authenticated') {
      return
    }

    const normalizedId = normalizeBlockId(waitingForBlockId)
    const hasExecuted = blockOutputs[normalizedId]?.values !== undefined
    if (!hasExecuted) {
      return // still waiting
    }

    const resume = async () => {
      const result = await tryBlockCredentials(waitingForBlockId)
      if (result.success && result.detected) {
        setDetectedCredentials(result.detected)
        setDetectionStatus('detected')
        setWaitingForBlockId(null)
        return
      }

      setWaitingForBlockId(null)
      const remaining = remainingSourcesRef.current
      remainingSourcesRef.current = []
      if (remaining.length > 0) {
        await trySourcesInOrder(remaining, false)
      } else {
        setDetectionStatus('done')
      }
    }

    void resume()
  }, [waitingForBlockId, detectionStatus, authStatus, blockOutputs, tryBlockCredentials, trySourcesInOrder])

  // ---------------------------------------------------------------------------
  // Detection handlers
  // ---------------------------------------------------------------------------

  /**
   * "Use These Credentials". MAIN re-validates (credentials may have changed
   * between detect and confirm), writes the session env, and returns metadata;
   * the outputs are registered from the CONFIRM response, never from
   * `detectedCredentials`.
   */
  const handleConfirmDetected = useCallback(async () => {
    if (!detectedCredentials) return

    setAuthStatus('authenticating')
    setErrorMessage(null)
    invalidateBlockOutputs()

    const source = detectedCredentials.source
    const resolvedProjectId = project || detectedCredentials.projectId || ''

    try {
      if (source === 'env' || source === 'adc' || source === 'gcloud') {
        const data = await api.invoke('google:env-credentials-confirm', {
          blockId: id,
          ...(detectedCredentials.envPrefix ? { prefix: detectedCredentials.envPrefix } : {}),
          source,
          ...(detectedCredentials.configuration ? { configuration: detectedCredentials.configuration } : {}),
          ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
          ...(effectiveRegion ? { region: effectiveRegion } : {}),
          ...(effectiveZone ? { zone: effectiveZone } : {}),
          ...(scopes && scopes.length > 0 ? { scopes } : {}),
        })

        if (!data.valid) {
          if (data.insufficientScopes && data.missingScopes?.length) {
            setDetectedCredentials({
              ...detectedCredentials,
              missingScopes: data.missingScopes,
              ...(data.grantedScopes ? { grantedScopes: data.grantedScopes } : {}),
            })
            setAuthStatus('pending')
            setErrorMessage(null)
            return
          }
          setAuthStatus('failed')
          setErrorMessage(data.error || 'Failed to register the detected credentials')
          return
        }

        await completeAuthentication({
          projectId: data.projectId ?? resolvedProjectId,
          ...(detectedCredentials.projectName ? { projectName: detectedCredentials.projectName } : {}),
          ...(data.account?.principal ? { principal: data.account.principal } : {}),
          ...(data.account?.accountType ? { accountType: data.account.accountType } : {}),
          credentialType: data.credentialType ?? detectedCredentials.credentialType,
          ...(data.account?.scopes ? { scopes: data.account.scopes } : {}),
          ...(data.credentialsPath ? { credentialsPath: data.credentialsPath } : {}),
          region: effectiveRegion,
          zone: effectiveZone,
          ...(data.sessionEnvWarning ? { sessionEnvWarning: data.sessionEnvWarning } : {}),
        })
        appendWarning(detectionWarning)
        return
      }

      if (source === 'block') {
        // Only ONE { block: … } source is allowed per block (the component
        // reports a configuration error otherwise), which is what makes this
        // `find` unambiguous.
        const blockSource = Array.isArray(detectCredentials)
          ? (detectCredentials.find((s) => typeof s === 'object' && 'block' in s) as { block: string } | undefined)
          : undefined

        if (blockSource) {
          const blockResult = getBlockCredentials(blockSource.block)
          if (blockResult.found && blockResult.creds) {
            const data = await api.invoke('google:validate-credentials', {
              blockId: id,
              ...blockResult.creds,
              ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
              ...(effectiveRegion ? { region: effectiveRegion } : {}),
              ...(effectiveZone ? { zone: effectiveZone } : {}),
              registerSession: true,
              ...(scopes && scopes.length > 0 ? { scopes } : {}),
            })

            if (!data.valid) {
              if (data.insufficientScopes && data.missingScopes?.length) {
                setDetectedCredentials({
                  ...detectedCredentials,
                  missingScopes: data.missingScopes,
                  ...(data.grantedScopes ? { grantedScopes: data.grantedScopes } : {}),
                })
                setAuthStatus('pending')
                setErrorMessage(null)
                return
              }
              setAuthStatus('failed')
              setErrorMessage(data.error || 'Failed to register the detected credentials')
              return
            }

            await completeAuthentication({
              projectId: data.projectId ?? resolvedProjectId,
              ...(data.projectName ? { projectName: data.projectName } : {}),
              ...(data.account?.principal ? { principal: data.account.principal } : {}),
              ...(data.account?.accountType ? { accountType: data.account.accountType } : {}),
              credentialType: data.credentialType ?? detectedCredentials.credentialType,
              ...(data.account?.scopes ? { scopes: data.account.scopes } : {}),
              ...(data.credentialsPath ? { credentialsPath: data.credentialsPath } : {}),
              region: effectiveRegion,
              zone: effectiveZone,
              ...(data.sessionEnvWarning ? { sessionEnvWarning: data.sessionEnvWarning } : {}),
            })
            appendWarning(detectionWarning)
            return
          }
        }
      }
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to register the detected credentials')
      return
    }

    setAuthStatus('failed')
    setErrorMessage('Failed to confirm the detected credentials')
  }, [
    api,
    id,
    detectedCredentials,
    detectCredentials,
    detectionWarning,
    project,
    scopes,
    effectiveRegion,
    effectiveZone,
    getBlockCredentials,
    completeAuthentication,
    appendWarning,
    invalidateBlockOutputs,
  ])

  /**
   * "Use Different Credentials". Nothing was written to the session, so there
   * is nothing to undo — just fall through to the manual tabs.
   */
  const handleRejectDetected = useCallback(() => {
    setDetectedCredentials(null)
    setDetectionWarning(null)
    setDetectionStatus('done')
    setAuthStatus('pending')
  }, [])

  /**
   * "Try auto-detection again" — full reset plus a counter bump to re-fire.
   *
   * The link renders while an OAuth flow may still be live (the form subtree,
   * and with it the flow's Cancel button, unmounts the moment detection goes
   * back to 'pending'), so the flow has to be released here exactly as
   * `handleManualAuth` does. Otherwise MAIN keeps its loopback listener bound,
   * the poll loop keeps running against an unmounted card, and finishing the
   * consent screen later would flip the block to 'authenticated' for a
   * credential the user abandoned.
   */
  const handleRetryDetection = useCallback(() => {
    stopOAuthPolling()
    setOauthFlowId(null)
    setOauthAuthUrl(null)
    setDetectedCredentials(null)
    setDetectionWarning(null)
    setDetectionStatus('pending')
    setAuthStatus('pending')
    setErrorMessage(null)
    setWarningMessage(null)
    setRetryFoundNothing(false)
    setWaitingForBlockId(null)
    remainingSourcesRef.current = []
    detectionAttemptedRef.current = false
    setDetectionAttempt((prev) => prev + 1)
  }, [stopOAuthPolling])

  // ---------------------------------------------------------------------------
  // Tab 1 — service account key
  // ---------------------------------------------------------------------------

  /**
   * Choose a service-account key file. The renderer records the PATH ONLY.
   *
   * The key's contents are deliberately never read here: MAIN already accepts a
   * `keyPath` and reads/validates it in-process, so pulling the document into
   * React state would put `private_key` in the component tree, in DevTools, in
   * any renderer heap snapshot, and back over IPC — exactly what this block's
   * custody rule forbids. It would also fail for the common case, since
   * `file:read` only serves paths inside the workspace and keys normally live
   * in ~/Downloads.
   */
  const loadKeyFromFile = useCallback(async () => {
    try {
      const result = await api.invoke('native:show-open-dialog', {
        properties: ['openFile'],
        filters: [
          { name: 'Service Account Key', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      })

      const filePath = result.filePaths?.[0]
      if (!filePath) return // user cancelled

      // A chosen file replaces anything pasted, so exactly one credential is
      // ever in play.
      setServiceAccountKey('')
      setKeyFilePath(filePath)
      setKeyFileName(filePath.split(/[\\/]/).pop() || filePath)
      setErrorMessage(null)
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to open the file picker')
    }
  }, [api])

  /**
   * Typing or pasting a key clears a previously chosen file: the two inputs are
   * alternatives, and submit must be unambiguous about which one it sends.
   */
  const updateServiceAccountKey = useCallback((value: string) => {
    setServiceAccountKey(value)
    if (value) {
      setKeyFilePath(null)
      setKeyFileName(null)
    }
  }, [])

  const submitServiceAccountKey = useCallback(async () => {
    setAuthStatus('authenticating')
    setErrorMessage(null)
    setWarningMessage(null)
    invalidateBlockOutputs()

    // The picker's value wins over the prop; the key's own project_id (resolved
    // in MAIN) is the fallback when neither is set.
    const requestedProject = projectIdInput.trim() || project || ''

    try {
      const data = await api.invoke('google:validate-credentials', {
        blockId: id,
        // A chosen file is sent as a PATH; only a pasted key travels as JSON.
        ...(keyFilePath ? { keyPath: keyFilePath } : { keyJson: serviceAccountKey }),
        ...(requestedProject ? { projectId: requestedProject } : {}),
        ...(effectiveRegion ? { region: effectiveRegion } : {}),
        ...(effectiveZone ? { zone: effectiveZone } : {}),
        registerSession: true,
      })

      if (!data.valid) {
        setAuthStatus('failed')
        setErrorMessage(data.error || 'Failed to validate the service account key')
        return
      }

      const visibleProjects = (data.projects ?? []) as GoogleProjectInfo[]
      setProjects(visibleProjects)
      pendingCredentialsPathRef.current = data.credentialsPath ?? null

      const identity: PendingAccount = {
        ...(data.account?.principal ? { principal: data.account.principal } : {}),
        ...(data.account?.accountType ? { accountType: data.account.accountType } : {}),
        credentialType: data.credentialType ?? 'service_account',
        ...(data.account?.scopes ? { scopes: data.account.scopes } : {}),
        ...(data.credentialsPath ? { credentialsPath: data.credentialsPath } : {}),
      }

      const resolvedProjectId = project || data.projectId || requestedProject || ''

      if (resolvedProjectId) {
        // MAIN already wrote the project into the session env during validate.
        await completeAuthentication({
          ...identity,
          projectId: resolvedProjectId,
          ...(data.projectName ? { projectName: data.projectName } : {}),
          region: effectiveRegion,
          zone: effectiveZone,
          ...(data.sessionEnvWarning ? { sessionEnvWarning: data.sessionEnvWarning } : {}),
        })
        return
      }

      if (visibleProjects.length === 1) {
        await selectProject(visibleProjects[0], identity)
        return
      }

      if (visibleProjects.length > 1) {
        setAccountInfo({
          ...(identity.principal ? { principal: identity.principal } : {}),
          ...(identity.accountType ? { accountType: identity.accountType } : {}),
          ...(identity.credentialType ? { credentialType: identity.credentialType } : {}),
          ...(identity.scopes ? { scopes: identity.scopes } : {}),
          ...(identity.credentialsPath ? { credentialsPath: identity.credentialsPath } : {}),
        })
        appendWarning(data.sessionEnvWarning)
        setAuthStatus('select_project')
        return
      }

      // A validated credential the caller cannot enumerate projects for: still
      // authenticated, just without a project to pin.
      await completeAuthentication({
        ...identity,
        projectId: '',
        region: effectiveRegion,
        zone: effectiveZone,
        ...(data.sessionEnvWarning ? { sessionEnvWarning: data.sessionEnvWarning } : {}),
      })
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to connect to server')
    }
  }, [
    api,
    id,
    serviceAccountKey,
    keyFilePath,
    projectIdInput,
    project,
    effectiveRegion,
    effectiveZone,
    completeAuthentication,
    selectProject,
    appendWarning,
    invalidateBlockOutputs,
  ])

  const handleServiceAccountSubmit = useCallback(() => {
    if (!serviceAccountKey.trim() && !keyFilePath) {
      setAuthStatus('failed')
      setErrorMessage('A service account key JSON is required')
      return
    }
    void submitServiceAccountKey()
  }, [serviceAccountKey, keyFilePath, submitServiceAccountKey])

  // ---------------------------------------------------------------------------
  // Tab 2 — Google sign-in (loopback OAuth)
  // ---------------------------------------------------------------------------

  /**
   * Finish an OAuth login. The poll result is METADATA-ONLY: MAIN has already
   * exchanged the code, materialised the ADC file, and written the session env.
   */
  const finishOAuth = useCallback(async (data: {
    account?: { principal: string; accountType: 'service_account' | 'user'; scopes?: string[] }
    projectId?: string
    credentialsPath?: string
    projects?: GoogleProjectInfo[]
    scopes?: string[]
    sessionEnvWarning?: string
  }) => {
    const visibleProjects = (data.projects ?? []) as GoogleProjectInfo[]
    setProjects(visibleProjects)
    pendingCredentialsPathRef.current = data.credentialsPath ?? null

    // The loopback listener is finished; only a LIVE flow keeps an id.
    oauthFlowIdRef.current = null
    setOauthFlowId(null)
    setOauthAuthUrl(null)

    const identity: PendingAccount = {
      ...(data.account?.principal ? { principal: data.account.principal } : {}),
      ...(data.account?.accountType ? { accountType: data.account.accountType } : {}),
      credentialType: 'authorized_user',
      ...(data.scopes ?? data.account?.scopes ? { scopes: data.scopes ?? data.account?.scopes } : {}),
      ...(data.credentialsPath ? { credentialsPath: data.credentialsPath } : {}),
    }

    if (project) {
      const pinned = visibleProjects.find((p) => p.projectId === project) ?? {
        projectId: project,
        displayName: project,
      }
      await selectProject(pinned, identity)
      return
    }

    if (visibleProjects.length === 1) {
      await selectProject(visibleProjects[0], identity)
      return
    }

    if (visibleProjects.length > 1) {
      setAccountInfo({
        ...(identity.principal ? { principal: identity.principal } : {}),
        ...(identity.accountType ? { accountType: identity.accountType } : {}),
        ...(identity.credentialType ? { credentialType: identity.credentialType } : {}),
        ...(identity.scopes ? { scopes: identity.scopes } : {}),
        ...(identity.credentialsPath ? { credentialsPath: identity.credentialsPath } : {}),
      })
      appendWarning(data.sessionEnvWarning)
      setAuthStatus('select_project')
      return
    }

    // No project list to choose from — MAIN's resolved project (if any) stands.
    await completeAuthentication({
      ...identity,
      projectId: data.projectId ?? '',
      region: effectiveRegion,
      zone: effectiveZone,
      ...(data.sessionEnvWarning ? { sessionEnvWarning: data.sessionEnvWarning } : {}),
    })
  }, [project, effectiveRegion, effectiveZone, selectProject, completeAuthentication, appendWarning])

  /**
   * Poll the loopback flow. Cancellation is checked before AND after every
   * await, and the pending timeout is cleared on unmount, so a torn-down block
   * never writes state or leaves MAIN's listener open.
   */
  const pollOAuthCompletion = useCallback((flowId: string) => {
    let attempts = 0

    /**
     * Every terminal renderer path goes through `stopOAuthPolling`, which is
     * what actually issues `google:oauth-cancel`. Abandoning the flow without
     * it leaves MAIN's loopback listener bound for the rest of its TTL — and if
     * the user then finishes consent in the still-open browser tab, the
     * exchanged refresh token sits in main-process memory with nothing left to
     * collect or reap it.
     */
    const fail = (message: string) => {
      stopOAuthPolling()
      setOauthFlowId(null)
      setOauthAuthUrl(null)
      setAuthStatus('failed')
      setErrorMessage(message)
    }

    const poll = async () => {
      if (oauthPollCancelledRef.current) return

      try {
        const data = await api.invoke('google:oauth-poll', { flowId, blockId: id })

        if (oauthPollCancelledRef.current) return

        if (data.status === 'pending') {
          if (attempts >= OAUTH_POLL_MAX_ATTEMPTS) {
            fail('Google sign-in timed out. Please try again.')
            return
          }
          attempts++
          oauthPollTimeoutRef.current = setTimeout(() => { void poll() }, OAUTH_POLL_INTERVAL_MS)
          return
        }

        if (data.status === 'complete') {
          await finishOAuth(data as Parameters<typeof finishOAuth>[0])
          return
        }

        if (data.status === 'expired') {
          fail('Authorization request expired. Please try again.')
          return
        }

        fail(data.error || 'Google sign-in failed')
      } catch (error) {
        if (oauthPollCancelledRef.current) return
        fail(error instanceof Error ? error.message : 'Failed to check the sign-in status')
      }
    }

    void poll()
  }, [api, id, finishOAuth, stopOAuthPolling])

  /**
   * Choose a Desktop-app OAuth client JSON (`{ "installed": { client_id,
   * client_secret, … } }`). Path only — MAIN parses it at oauth-start, so the
   * secret never enters the renderer (same custody rule as the SA key picker).
   */
  const loadOAuthClientFromFile = useCallback(async () => {
    try {
      const result = await api.invoke('native:show-open-dialog', {
        properties: ['openFile'],
        filters: [
          { name: 'Desktop OAuth client JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      })

      const filePath = result.filePaths?.[0]
      if (!filePath) return // user cancelled

      setOauthClientFilePath(filePath)
      setOauthClientFileName(filePath.split(/[\\/]/).pop() || filePath)
      setOauthUnavailable(false)
      setErrorMessage(null)
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to open the file picker')
    }
  }, [api])

  const clearOAuthClientFile = useCallback(() => {
    setOauthClientFilePath(null)
    setOauthClientFileName(null)
    // Re-probe ambient config; without an author prop the tab may need a client
    // again. Author props keep Sign-In available regardless.
    if (oauthClientId || oauthClientFile) {
      setOauthUnavailable(false)
      return
    }
    void api
      .invoke('google:oauth-available', {})
      .then((data) => setOauthUnavailable(data?.available !== true))
      .catch(() => setOauthUnavailable(true))
  }, [api, oauthClientId, oauthClientFile])

  const handleOAuthLogin = useCallback(async () => {
    oauthPollCancelledRef.current = false
    setAuthStatus('authenticating')
    setErrorMessage(null)
    setWarningMessage(null)
    // Withdrawn up front, not on completion: consent happens in a browser and the
    // block sits in this state for as long as the user takes.
    invalidateBlockOutputs()

    try {
      // MAIN resolves the Desktop client (props / file / env / build default)
      // and owns scopes defaults; only author/operator overrides are sent, so a
      // build's registered client never round-trips the renderer. A clientFile
      // path is read in MAIN — its secret never enters the renderer.
      const data = await api.invoke('google:oauth-start', {
        ...(oauthClientId ? { clientId: oauthClientId } : {}),
        ...(oauthClientSecret ? { clientSecret: oauthClientSecret } : {}),
        ...(effectiveOauthClientFile ? { clientFile: effectiveOauthClientFile } : {}),
        ...(scopes && scopes.length > 0 ? { scopes } : {}),
      })

      if (!data.flowId || !data.authUrl) {
        if (OAUTH_NOT_CONFIGURED_PATTERN.test(data.error ?? '')) {
          setOauthUnavailable(true)
        }
        setAuthStatus('failed')
        setErrorMessage(data.error || 'Failed to start Google sign-in')
        return
      }

      oauthFlowIdRef.current = data.flowId
      setOauthFlowId(data.flowId)
      setOauthAuthUrl(data.authUrl)

      try {
        await api.invoke('native:open-external', { url: data.authUrl })
      } catch (error) {
        // Not fatal — the card renders the URL so the user can open it manually.
        console.error('Failed to open the Google sign-in URL:', error)
      }

      pollOAuthCompletion(data.flowId)
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to connect to server')
    }
  }, [api, oauthClientId, oauthClientSecret, effectiveOauthClientFile, scopes, pollOAuthCompletion, invalidateBlockOutputs])

  const handleCancelOAuth = useCallback(() => {
    stopOAuthPolling()
    setOauthFlowId(null)
    setOauthAuthUrl(null)
    setAuthStatus('pending')
    setErrorMessage(null)
  }, [stopOAuthPolling])

  /**
   * Decline an insufficient-scopes detection and start Google Sign-In with the
   * author's required scopes. When Sign-In still has no client (and the operator
   * has not picked a Desktop JSON yet) the insufficient-scopes card shows the
   * gcloud --scopes command instead; this handler is a no-op for that path
   * beyond clearing the detection card.
   */
  const handleSignInWithRequiredScopes = useCallback(async () => {
    handleRejectDetected()
    if (oauthUnavailable && !oauthClientId && !effectiveOauthClientFile) {
      return
    }
    setAuthMethod('oauth')
    await handleOAuthLogin()
  }, [handleRejectDetected, oauthUnavailable, oauthClientId, effectiveOauthClientFile, handleOAuthLogin])


  // Cleanup on unmount: stop polling and release MAIN's loopback listener.
  useEffect(() => {
    return () => {
      stopOAuthPolling()
    }
  }, [stopOAuthPolling])

  /**
   * Ask MAIN once, on mount, whether an OAuth client is resolvable (build
   * default or operator env). Author props/file and an in-session operator
   * pick skip the probe — those are available by definition. When nothing is
   * configured the Sign-In tab stays selectable and OAuthFlow offers a Desktop
   * client JSON picker (plus the GOOGLE_OAUTH_CLIENT_CREDENTIALS env hint).
   */
  useEffect(() => {
    if (oauthClientId || oauthClientFile || oauthClientFilePath) {
      setOauthUnavailable(false)
      return
    }

    let cancelled = false
    void api
      .invoke('google:oauth-available', {})
      .then((data) => {
        if (!cancelled) setOauthUnavailable(data?.available !== true)
      })
      .catch(() => {
        // Probe unavailable: leave Sign-In selectable and let oauth-start (or
        // the Desktop client picker) have the last word.
      })

    return () => {
      cancelled = true
    }
  }, [api, oauthClientId, oauthClientFile, oauthClientFilePath])

  // ---------------------------------------------------------------------------
  // Tab 3 — gcloud configuration
  // ---------------------------------------------------------------------------

  /** Pure disk read of the gcloud config root; no gcloud binary is invoked. */
  const loadGcloudConfigs = useCallback(async () => {
    setLoadingConfigs(true)
    try {
      const data = await api.invoke('google:gcloud-configurations', {})
      const list = (data.configurations ?? []) as GcloudConfigInfo[]
      setGcloudConfigs(list)
      setAdcInfo((data.adc as AdcInfo | undefined) ?? null)
      setGcloudConfigRoot(data.configRoot ?? null)

      // A configuration without Application Default Credentials cannot
      // authenticate, so it is listed but never auto-selected.
      const usable = (c: GcloudConfigInfo) => c.authType !== 'config-only' && c.authType !== 'unsupported'
      const pinned = gcloudConfiguration ? list.find((c) => c.name === gcloudConfiguration) : undefined
      const active = list.find((c) => c.isActive && usable(c))
      const firstUsable = list.find(usable)
      const choice = pinned ?? active ?? firstUsable
      if (choice) {
        setSelectedConfig(choice)
      }
    } catch (error) {
      console.error('Failed to load gcloud configurations:', error)
      setGcloudConfigs([])
    } finally {
      setLoadingConfigs(false)
    }
  }, [api, gcloudConfiguration])

  const handleGcloudAuth = useCallback(async () => {
    if (!selectedConfig) {
      setAuthStatus('failed')
      setErrorMessage('Please select a gcloud configuration')
      return
    }

    if (selectedConfig.authType === 'config-only') {
      setAuthStatus('failed')
      setErrorMessage(
        'Configuration found, but no Application Default Credentials — run `gcloud auth application-default login`.'
      )
      return
    }

    if (selectedConfig.authType === 'unsupported') {
      setAuthStatus('failed')
      setErrorMessage('This authentication method is not supported')
      return
    }

    setAuthStatus('authenticating')
    setErrorMessage(null)
    setWarningMessage(null)
    invalidateBlockOutputs()

    // The configuration's own compute defaults apply when the block did not
    // pin a region/zone.
    const region = effectiveRegion || selectedConfig.region || ''
    const zone = effectiveZone || selectedConfig.zone || ''
    const requestedProject = project || selectedConfig.project || ''

    try {
      const data = await api.invoke('google:gcloud-auth', {
        blockId: id,
        configuration: selectedConfig.name,
        ...(requestedProject ? { projectId: requestedProject } : {}),
        ...(region ? { region } : {}),
        ...(zone ? { zone } : {}),
        ...(scopes && scopes.length > 0 ? { scopes } : {}),
      })

      if (!data.valid) {
        setAuthStatus('failed')
        setErrorMessage(data.error || 'Failed to authenticate with the selected gcloud configuration')
        return
      }

      // Keep the visible projects so "Change project" needs no extra round trip.
      const visibleProjects = (data.projects ?? []) as GoogleProjectInfo[]
      setProjects(visibleProjects)
      pendingCredentialsPathRef.current = data.credentialsPath ?? null

      const identity: PendingAccount = {
        ...(data.account?.principal ? { principal: data.account.principal } : {}),
        ...(data.account?.accountType ? { accountType: data.account.accountType } : {}),
        credentialType:
          selectedConfig.authType === 'adc-service-account' ? 'service_account' : 'authorized_user',
        ...(data.account?.scopes ? { scopes: data.account.scopes } : {}),
        ...(data.credentialsPath ? { credentialsPath: data.credentialsPath } : {}),
      }

      const resolvedProjectId = data.projectId ?? requestedProject

      // A gcloud configuration need not set `core/project`. When it does not,
      // this tab routes into project selection exactly like the other two
      // rather than reporting success with a blank GOOGLE_CLOUD_PROJECT.
      if (resolvedProjectId) {
        await completeAuthentication({
          ...identity,
          projectId: resolvedProjectId,
          region,
          zone,
          ...(data.sessionEnvWarning ? { sessionEnvWarning: data.sessionEnvWarning } : {}),
        })
        return
      }

      if (visibleProjects.length === 1) {
        await selectProject(visibleProjects[0], identity, { region, zone })
        return
      }

      if (visibleProjects.length > 1) {
        setAccountInfo({
          ...(identity.principal ? { principal: identity.principal } : {}),
          ...(identity.accountType ? { accountType: identity.accountType } : {}),
          ...(identity.credentialType ? { credentialType: identity.credentialType } : {}),
          ...(identity.scopes ? { scopes: identity.scopes } : {}),
          ...(identity.credentialsPath ? { credentialsPath: identity.credentialsPath } : {}),
        })
        // The configuration's own compute defaults have to survive the trip
        // through the picker, which otherwise only knows about the props.
        pendingComputeRef.current = { region, zone }
        appendWarning(data.sessionEnvWarning)
        setAuthStatus('select_project')
        return
      }

      // Authenticated, but nothing anywhere names a project. completeAuthentication
      // says so on the success card instead of pretending the block is ready.
      await completeAuthentication({
        ...identity,
        projectId: '',
        region,
        zone,
        ...(data.sessionEnvWarning ? { sessionEnvWarning: data.sessionEnvWarning } : {}),
      })
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to connect to server')
    }
  }, [
    api,
    id,
    selectedConfig,
    project,
    scopes,
    effectiveRegion,
    effectiveZone,
    completeAuthentication,
    selectProject,
    appendWarning,
    invalidateBlockOutputs,
  ])

  // ---------------------------------------------------------------------------
  // Project selection + reset
  // ---------------------------------------------------------------------------

  const handleProjectSelect = useCallback(async (p: GoogleProjectInfo) => {
    await selectProject(p)
  }, [selectProject])

  /** From the success card: go back to the picker, loading it if it is empty. */
  const handleChangeProject = useCallback(async () => {
    setErrorMessage(null)
    setProjectSearch('')
    setAuthStatus('select_project')
    if (projects.length === 0) {
      await loadProjects()
    }
  }, [projects.length, loadProjects])

  /** "Re-authenticate": clear everything and land back on the manual tabs. */
  const handleManualAuth = useCallback(() => {
    stopOAuthPolling()
    // The card going blue has to take the block's outputs with it, or steps keep
    // injecting the credential this reset exists to replace.
    invalidateBlockOutputs()
    setAuthStatus('pending')
    setErrorMessage(null)
    setWarningMessage(null)
    setAccountInfo(null)
    setProjects([])
    setSelectedProject(null)
    setProjectSearch('')
    setOauthFlowId(null)
    setOauthAuthUrl(null)
    setDetectedCredentials(null)
    setDetectionWarning(null)
    setDetectionStatus('done')
    setWaitingForBlockId(null)
    remainingSourcesRef.current = []
    pendingCredentialsPathRef.current = null
    pendingComputeRef.current = null
  }, [stopOAuthPolling, invalidateBlockOutputs])

  return {
    // Core state
    authMethod,
    setAuthMethod,
    authStatus,
    errorMessage,
    warningMessage,
    accountInfo,

    // Detection state
    detectionStatus,
    detectedCredentials,
    detectionWarning,
    waitingForBlockId,
    retryFoundNothing,
    clearRetryMessage,

    // Service-account tab
    serviceAccountKey,
    setServiceAccountKey: updateServiceAccountKey,
    showServiceAccountKey,
    setShowServiceAccountKey,
    keyFileName,
    keyFilePath,
    loadKeyFromFile,
    projectIdInput,
    setProjectIdInput,

    // Region / zone
    selectedRegion,
    setSelectedRegion,
    selectedZone,
    setSelectedZone,

    // gcloud tab
    gcloudConfigs,
    selectedConfig,
    setSelectedConfig,
    loadingConfigs,
    configSearch,
    setConfigSearch,
    loadGcloudConfigs,
    adcInfo,
    gcloudConfigRoot,

    // OAuth tab
    oauthFlowId,
    oauthAuthUrl,
    oauthUnavailable,
    oauthClientFileName,
    oauthClientFilePath,
    loadOAuthClientFromFile,
    clearOAuthClientFile,

    // Project selection
    projects,
    selectedProject,
    loadingProjects,
    projectSearch,
    setProjectSearch,

    // Handlers
    handleServiceAccountSubmit,
    handleOAuthLogin,
    handleCancelOAuth,
    handleGcloudAuth,
    handleProjectSelect,
    handleChangeProject,
    handleConfirmDetected,
    handleRejectDetected,
    handleRetryDetection,
    handleManualAuth,
    handleSignInWithRequiredScopes,
  }
}
