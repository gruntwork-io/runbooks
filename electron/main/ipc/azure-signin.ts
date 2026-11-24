import { Effect, Stream } from "effect"
import { runtime, sessionManager } from "./runtime.ts"
import {
  abandonConfigDir,
  adoptConfigDir,
  commitConfigDir,
  copyUserConfigDir,
  createConfigDir,
  hasUserAzureSignIn,
  userAzureExtensionDir,
} from "./azure-config-dirs.ts"
import {
  checkRequiredRoles,
  detectEnvServicePrincipal,
  interactiveLoginArgs,
  isTenantGuid,
  listAccounts,
  listTenants,
  loginServicePrincipal,
  missingRolesMessage,
  parseDeviceCodePrompt,
  principalFor,
  refreshSubscriptions,
  resolveContextOptions,
  setSubscription,
  showAccount,
  type DeviceCodePrompt,
  type RequiredRole,
} from "../../../src/domain/azure/auth.ts"
import { azFailure, spawnAz, type AzContext } from "../../../src/domain/azure/cli.ts"
import { azureSessionEnv, type AzureAuthType } from "../../../src/domain/azure/env.ts"
import { ENV_PREFIX_PATTERN } from "../../../src/domain/env-prefix.ts"
import { redactSecrets, registerSecret } from "../../../src/domain/vcs/redact.ts"
import { errorMessage } from "../../../src/errors/message.ts"
import { makeLogger } from "../logger.ts"
import type { SpawnedProcess } from "../../../src/services/ProcessSpawner.ts"
import type {
  AzureDetectionSourceIpc,
  AzureSignInPinsIpc,
  AzureSignInResultIpc,
} from "../../shared/channels.ts"

type Result = AzureSignInResultIpc

const log = makeLogger("ipc:azure")

const toErrorMessage = (err: unknown): string => redactSecrets(errorMessage(err))

const isCliMissing = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { cliMissing?: unknown }).cliMissing === true

const needsTenantSignIn = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  (err as { interactionRequired?: unknown }).interactionRequired === true

const failed = (err: unknown): Result => ({
  status: "failed",
  error: toErrorMessage(err),
  ...(isCliMissing(err) ? { cliMissing: true } : {}),
  ...(needsTenantSignIn(err) ? { interactionRequired: true } : {}),
})

const SUPERSEDED: Result = { status: "failed", error: "This sign-in was cancelled" }

interface BlockSignIn {
  readonly ctx: AzContext
  readonly authType: AzureAuthType
  readonly clientId?: string | undefined
  readonly clientSecret?: string | undefined
  readonly certificatePath?: string | undefined
}

interface Attempt {
  readonly blockId: string
  readonly attempt: number
  readonly generation: number
}

const signInsByBlock = new Map<string, BlockSignIn>()
const attemptByBlock = new Map<string, number>()

const bumpAttempt = (blockId: string) => {
  const attempt = (attemptByBlock.get(blockId) ?? 0) + 1
  attemptByBlock.set(blockId, attempt)
  return attempt
}

const newAttempt = (blockId: string): Attempt => ({
  blockId,
  attempt: bumpAttempt(blockId),
  generation: sessionManager.getGeneration(),
})

const isCurrent = (at: Attempt) =>
  attemptByBlock.get(at.blockId) === at.attempt && sessionManager.isCurrentGeneration(at.generation)

export function resetAzureSignIns(): void {
  for (const flow of flows.values()) killFlow(flow)
  flows.clear()
  signInsByBlock.clear()
  attemptByBlock.clear()
}

async function applySessionEnv(
  change: ReturnType<typeof azureSessionEnv>,
  generation: number,
): Promise<string | undefined> {
  try {
    await runtime.runPromise(
      sessionManager.appendToEnv(change.set as Record<string, string>, generation),
    )
    if (change.clear.length > 0) {
      await runtime.runPromise(sessionManager.removeFromEnv(change.clear, generation))
    }
    return undefined
  } catch (err) {
    return `Signed in, but the sign-in could not be saved to the session (${toErrorMessage(err)}). Blocks without azureAuthId may not see it.`
  }
}

async function commitContext(
  at: Attempt,
  signIn: BlockSignIn,
  choice: { tenantId: string; subscriptionId?: string | undefined },
  pins: {
    readonly requiredRoles?: readonly RequiredRole[] | undefined
    readonly principalObjectId?: string | undefined
  },
): Promise<Result> {
  const { ctx } = signIn
  const { requiredRoles } = pins
  const principal = await runtime.runPromise(principalFor(ctx, choice.tenantId))
  if (pins.principalObjectId && principal.objectId !== pins.principalObjectId) {
    return {
      status: "failed",
      error: `This sign-in is now ${principal.name}, not the account the block used before`,
    }
  }
  if (requiredRoles && requiredRoles.length > 0) {
    const missing = await runtime.runPromise(
      checkRequiredRoles(ctx, principal, requiredRoles, choice.subscriptionId),
    )
    if (missing.length > 0) {
      return {
        status: "failed",
        error: missingRolesMessage(missing, principal.name),
        missingRoles: missing,
      }
    }
  }

  // After the checks: a block whose tenant is being changed keeps using this
  // dir until the change is committed.
  if (choice.subscriptionId) await runtime.runPromise(setSubscription(ctx, choice.subscriptionId))

  const [accounts, tenants] = await Promise.all([
    runtime.runPromise(listAccounts(ctx)),
    runtime.runPromise(listTenants(ctx)),
  ])
  const subscriptionName = accounts.find((sub) => sub.id === choice.subscriptionId)?.name
  const tenantName = tenants.find((t) => t.tenantId === choice.tenantId.toLowerCase())?.displayName

  const change = azureSessionEnv({
    ...signIn,
    configDir: ctx.configDir,
    extensionDir: ctx.extensionDir,
    principal,
    tenantId: choice.tenantId,
    subscriptionId: choice.subscriptionId,
  })

  if (!isCurrent(at)) return SUPERSEDED
  const sessionEnvWarning = await applySessionEnv(change, at.generation)
  commitConfigDir(at.blockId, ctx.configDir)

  return {
    status: "authenticated",
    authType: signIn.authType,
    principal,
    tenantId: choice.tenantId,
    ...(tenantName ? { tenantName } : {}),
    ...(choice.subscriptionId ? { subscriptionId: choice.subscriptionId } : {}),
    ...(subscriptionName ? { subscriptionName } : {}),
    configDir: ctx.configDir,
    env: change.set as Record<string, string>,
    ...(sessionEnvWarning ? { sessionEnvWarning } : {}),
  }
}

/**
 * Who the picker says is signed in: the principal in the first of the tenants
 * that gives a token without a new sign-in. One tenant that wants MFA, or
 * refuses this account, doesn't fail a sign-in that works in another.
 */
async function pickerPrincipal(ctx: AzContext, tenantIds: readonly (string | undefined)[]) {
  const tried = new Set<string>()
  let firstError: unknown
  for (const tenantId of tenantIds) {
    if (!tenantId || tried.has(tenantId.toLowerCase())) continue
    tried.add(tenantId.toLowerCase())
    try {
      return await runtime.runPromise(principalFor(ctx, tenantId))
    } catch (err) {
      if (isCliMissing(err)) throw err
      firstError ??= err
    }
  }
  if (firstError !== undefined) throw firstError
  return runtime.runPromise(principalFor(ctx))
}

async function finishSignIn(
  at: Attempt,
  signIn: BlockSignIn,
  pins: AzureSignInPinsIpc,
): Promise<Result> {
  if (!isCurrent(at)) return SUPERSEDED
  signInsByBlock.set(at.blockId, signIn)
  const { ctx } = signIn
  const pinnedTenant =
    pins.tenantId && !isTenantGuid(pins.tenantId)
      ? (await runtime.runPromise(principalFor(ctx, pins.tenantId))).tenantId
      : pins.tenantId
  const [accounts, tenants, signedIn] = await Promise.all([
    runtime.runPromise(listAccounts(ctx)),
    runtime.runPromise(listTenants(ctx)),
    runtime.runPromise(showAccount(ctx)),
  ])
  const options = resolveContextOptions({
    accounts,
    tenants,
    signedInTenantId: signedIn?.tenantId,
    tenantId: pinnedTenant,
    subscriptionId: pins.subscriptionId,
  })
  if (options.chosen) return commitContext(at, signIn, options.chosen, pins)
  const principal = await pickerPrincipal(ctx, [
    signedIn?.tenantId,
    ...options.subscriptions.map((sub) => sub.tenantId),
    ...options.tenants.map((tenant) => tenant.tenantId),
  ])
  return {
    status: "select_context",
    authType: signIn.authType,
    principal,
    tenants: [...options.tenants],
    subscriptions: options.subscriptions.filter(
      (sub) => !pinnedTenant || sub.tenantId === pinnedTenant.toLowerCase(),
    ),
  }
}

async function signInOrRelease(
  at: Attempt,
  dir: string,
  step: () => Promise<Result>,
): Promise<Result> {
  try {
    const result = await step()
    if (result.status === "failed") abandonConfigDir(at.blockId, dir)
    return result
  } catch (err) {
    abandonConfigDir(at.blockId, dir)
    return failed(err)
  }
}

const invalidPrefix = (prefix: string | undefined) =>
  prefix && !ENV_PREFIX_PATTERN.test(prefix)
    ? `Invalid env prefix "${prefix}": must match ${ENV_PREFIX_PATTERN}`
    : undefined

const DETECT_KEY = " detect"

async function detectCliSignIn() {
  if (!hasUserAzureSignIn()) return undefined
  const dir = copyUserConfigDir(DETECT_KEY)
  try {
    const ctx: AzContext = { configDir: dir }
    const account = await runtime.runPromise(showAccount(ctx))
    if (!account) return undefined
    const principal = await runtime.runPromise(principalFor(ctx))
    return {
      found: true,
      source: "cli" as const,
      principalName: principal.name,
      tenantId: account.tenantId,
      ...(account.tenantLevel
        ? {}
        : { subscriptionId: account.id, subscriptionName: account.name }),
    }
  } finally {
    abandonConfigDir(DETECT_KEY, dir)
  }
}

export async function handleDetect(params: {
  prefix?: string
  sources: AzureDetectionSourceIpc[]
}) {
  const prefixError = invalidPrefix(params.prefix)
  if (prefixError) return { found: false, error: prefixError }

  let lastError: string | undefined
  for (const source of params.sources) {
    try {
      if (source === "cli") {
        const found = await detectCliSignIn()
        if (found) return found
        continue
      }
      const sp = await runtime.runPromise(detectEnvServicePrincipal(params.prefix || undefined))
      if (sp) {
        return {
          found: true,
          source,
          principalName: sp.clientId,
          tenantId: sp.tenantId,
          envVarPrefix: `${params.prefix ?? ""}${sp.envVarPrefix}`,
          ...(sp.subscriptionId ? { subscriptionId: sp.subscriptionId } : {}),
        }
      }
    } catch (err) {
      if (isCliMissing(err)) return { found: false, cliMissing: true, error: toErrorMessage(err) }
      lastError = toErrorMessage(err)
    }
  }
  return { found: false, ...(lastError ? { error: lastError } : {}) }
}

/**
 * The copy of the user's az login lists the subscriptions az saw when it last
 * fetched them, which leaves out any created since. Fetch them again; when
 * that fails, sign in with the list as it is.
 */
async function refreshCopiedSubscriptions(ctx: AzContext): Promise<void> {
  try {
    await runtime.runPromise(refreshSubscriptions(ctx))
  } catch (err) {
    log.warn(
      `Couldn't refresh the Azure subscriptions in ${ctx.configDir}; using the list copied from the az login: ${toErrorMessage(err)}`,
    )
  }
}

export async function handleConfirmDetected(
  params: AzureSignInPinsIpc & {
    blockId: string
    source: AzureDetectionSourceIpc
    prefix?: string
  },
): Promise<Result> {
  const prefixError = invalidPrefix(params.prefix)
  if (prefixError) return { status: "failed", error: prefixError }
  const at = newAttempt(params.blockId)

  if (params.source === "cli") {
    let dir: string
    try {
      dir = copyUserConfigDir(params.blockId)
    } catch (err) {
      return failed(err)
    }
    const ctx: AzContext = { configDir: dir, extensionDir: userAzureExtensionDir() }
    return signInOrRelease(at, dir, async () => {
      await refreshCopiedSubscriptions(ctx)
      return finishSignIn(at, { ctx, authType: "cli" }, params)
    })
  }

  const sp = await runtime
    .runPromise(detectEnvServicePrincipal(params.prefix || undefined))
    .catch(() => undefined)
  if (!sp) {
    return { status: "failed", error: "No service principal found in the environment any more" }
  }
  const subscriptionId = params.subscriptionId ?? sp.subscriptionId
  return signInServicePrincipal(at, sp, {
    ...params,
    ...(subscriptionId ? { subscriptionId } : {}),
  })
}

interface ServicePrincipalInput {
  readonly clientId: string
  readonly tenantId: string
  readonly clientSecret?: string | undefined
  readonly certificatePath?: string | undefined
}

async function signInServicePrincipal(
  at: Attempt,
  creds: ServicePrincipalInput,
  pins: AzureSignInPinsIpc,
): Promise<Result> {
  if (creds.clientSecret) registerSecret(creds.clientSecret)
  const dir = createConfigDir(at.blockId)
  const ctx: AzContext = { configDir: dir }
  return signInOrRelease(at, dir, async () => {
    await runtime.runPromise(loginServicePrincipal(ctx, creds))
    return finishSignIn(
      at,
      {
        ctx,
        authType: "service_principal",
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        certificatePath: creds.certificatePath,
      },
      { ...pins, tenantId: pins.tenantId ?? creds.tenantId },
    )
  })
}

export async function handleServicePrincipal(
  params: AzureSignInPinsIpc & {
    blockId: string
    clientId: string
    tenantId: string
    clientSecret?: string
    certificatePath?: string
  },
): Promise<Result> {
  const clientId = params.clientId?.trim()
  const tenantId = params.tenantId?.trim()
  if (!clientId || !tenantId) {
    return { status: "failed", error: "A client ID and a tenant ID are required" }
  }
  return signInServicePrincipal(
    newAttempt(params.blockId),
    {
      clientId,
      tenantId,
      clientSecret: params.clientSecret || undefined,
      certificatePath: params.certificatePath?.trim() || undefined,
    },
    params,
  )
}

const FLOW_TIMEOUT_MS = 15 * 60_000

/** A sign-in to one more tenant, in the dir of a block's existing sign-in. */
interface TenantSignIn {
  readonly signIn: BlockSignIn
  readonly choice: { tenantId: string; subscriptionId?: string | undefined }
  /** The dir's default subscription before az login changed it. */
  readonly previousSubscriptionId?: string | undefined
}

interface LoginFlow {
  readonly id: string
  readonly at: Attempt
  readonly dir: string
  readonly tenantSignIn?: TenantSignIn | undefined
  readonly authType: AzureAuthType
  readonly startedAt: number
  readonly process: SpawnedProcess
  readonly stderr: string[]
  prompt?: DeviceCodePrompt | undefined
  exitCode?: number
  result?: Promise<Result>
}

const flows = new Map<string, LoginFlow>()
let nextFlowId = 0

function killFlow(flow: LoginFlow): void {
  void runtime.runPromise(flow.process.kill).catch(() => {})
  if (flow.result === undefined && !flow.tenantSignIn) abandonConfigDir(flow.at.blockId, flow.dir)
}

interface LoginStart {
  flowId?: string
  error?: string
  cliMissing?: boolean
}

const startError = (err: unknown): LoginStart => ({
  error: toErrorMessage(err),
  ...(isCliMissing(err) ? { cliMissing: true } : {}),
})

export async function handleLoginStart(params: {
  blockId: string
  deviceCode: boolean
  tenantId?: string
}): Promise<LoginStart> {
  const at = newAttempt(params.blockId)
  const dir = createConfigDir(params.blockId)
  let process: SpawnedProcess
  try {
    process = await runtime.runPromise(
      spawnAz(
        { configDir: dir },
        interactiveLoginArgs(params.deviceCode, params.tenantId?.trim() || undefined),
      ),
    )
  } catch (err) {
    abandonConfigDir(params.blockId, dir)
    return startError(err)
  }
  return { flowId: watchFlow(at, dir, params.deviceCode ? "device_code" : "cli", process) }
}

/**
 * Sign in to one tenant again, interactively, in the dir of the block's
 * existing sign-in: for a tenant that gives no token without it (MFA,
 * consent). Polling the flow then commits the chosen tenant and subscription.
 */
export async function handleTenantLoginStart(params: {
  blockId: string
  tenantId: string
  subscriptionId?: string
}): Promise<LoginStart> {
  const signIn = signInsByBlock.get(params.blockId)
  if (!signIn || signIn.authType === "service_principal") {
    return { error: "This block isn't signed in. Sign in again." }
  }
  const at = newAttempt(params.blockId)
  const { ctx } = signIn
  const previous = await runtime.runPromise(showAccount(ctx)).catch(() => undefined)
  let process: SpawnedProcess
  try {
    process = await runtime.runPromise(
      spawnAz(ctx, interactiveLoginArgs(signIn.authType === "device_code", params.tenantId)),
    )
  } catch (err) {
    return startError(err)
  }
  const tenantSignIn: TenantSignIn = {
    signIn,
    choice: { tenantId: params.tenantId, subscriptionId: params.subscriptionId },
    ...(previous && !previous.tenantLevel ? { previousSubscriptionId: previous.id } : {}),
  }
  return { flowId: watchFlow(at, ctx.configDir, signIn.authType, process, tenantSignIn) }
}

function watchFlow(
  at: Attempt,
  dir: string,
  authType: AzureAuthType,
  process: SpawnedProcess,
  tenantSignIn?: TenantSignIn,
): string {
  const flow: LoginFlow = {
    id: `azure-login-${++nextFlowId}`,
    at,
    dir,
    ...(tenantSignIn ? { tenantSignIn } : {}),
    authType,
    startedAt: Date.now(),
    process,
    stderr: [],
  }
  flows.set(flow.id, flow)

  void runtime
    .runPromise(
      process.output.pipe(
        Stream.runForEach((line) =>
          Effect.sync(() => {
            if (line.source !== "stderr") return
            flow.stderr.push(line.line)
            flow.prompt ??= parseDeviceCodePrompt(line.line)
          }),
        ),
        Effect.andThen(process.exitCode),
      ),
    )
    .then(
      (code) => {
        flow.exitCode = code
      },
      () => {
        flow.exitCode = -1
      },
    )

  return flow.id
}

async function finishTenantSignIn(
  flow: LoginFlow,
  tenantSignIn: TenantSignIn,
  pins: AzureSignInPinsIpc,
): Promise<Result> {
  const { signIn, choice, previousSubscriptionId } = tenantSignIn
  let result: Result
  try {
    result = await commitContext(flow.at, signIn, choice, { requiredRoles: pins.requiredRoles })
  } catch (err) {
    result = needsTenantSignIn(err)
      ? {
          status: "failed",
          error: `You signed in, but tenant ${choice.tenantId} still asks for a new sign-in. Its admin can tell you what its sign-in policy requires.`,
        }
      : failed(err)
  }
  // az login made the new tenant the dir's default: a block still using the
  // dir for its old tenant gets its default subscription back.
  if (result.status !== "authenticated" && previousSubscriptionId) {
    await runtime
      .runPromise(setSubscription(signIn.ctx, previousSubscriptionId))
      .catch(() => undefined)
  }
  return result
}

export async function handleLoginPoll(
  params: AzureSignInPinsIpc & { flowId: string },
): Promise<Result | { status: "pending"; verificationUri?: string; userCode?: string }> {
  const flow = flows.get(params.flowId)
  if (!flow) return { status: "failed", error: "This sign-in is no longer running. Start again." }

  if (flow.exitCode === undefined) {
    if (Date.now() - flow.startedAt > FLOW_TIMEOUT_MS) {
      flows.delete(flow.id)
      killFlow(flow)
      return { status: "failed", error: "The sign-in timed out. Start again." }
    }
    return { status: "pending", ...flow.prompt }
  }

  if (flow.result === undefined) {
    if (flow.exitCode !== 0) {
      if (!flow.tenantSignIn) abandonConfigDir(flow.at.blockId, flow.dir)
      flow.result = Promise.resolve(failed(azFailure(flow.stderr, "az login")))
    } else if (flow.tenantSignIn) {
      flow.result = finishTenantSignIn(flow, flow.tenantSignIn, params)
    } else {
      flow.result = signInOrRelease(flow.at, flow.dir, () =>
        finishSignIn(flow.at, { ctx: { configDir: flow.dir }, authType: flow.authType }, params),
      )
    }
    void flow.result.finally(() => flows.delete(flow.id))
  }
  return flow.result
}

export function handleCancel(params: { blockId: string }): { ok: true } {
  bumpAttempt(params.blockId)
  for (const flow of flows.values()) {
    if (flow.at.blockId !== params.blockId) continue
    flows.delete(flow.id)
    killFlow(flow)
  }
  return { ok: true }
}

export async function handleSelectContext(params: {
  blockId: string
  tenantId: string
  subscriptionId?: string
  requiredRoles?: RequiredRole[]
}): Promise<Result> {
  const signIn = signInsByBlock.get(params.blockId)
  if (!signIn) return { status: "failed", error: "This block isn't signed in. Sign in again." }
  try {
    return await commitContext(
      newAttempt(params.blockId),
      signIn,
      { tenantId: params.tenantId, subscriptionId: params.subscriptionId },
      { requiredRoles: params.requiredRoles },
    )
  } catch (err) {
    return failed(err)
  }
}

/**
 * Open the tenant and subscription picker on a block's existing user sign-in,
 * to move it to another tenant without signing in again. The block keeps its
 * tenant until a choice is committed with azure:select-context.
 */
export async function handleChangeTenant(params: {
  blockId: string
  configDir: string
  authType: AzureAuthType
  tenantId: string
  extensionDir?: string
}): Promise<Result> {
  if (params.authType === "service_principal") {
    return {
      status: "failed",
      error: "A service principal signs in to one tenant. Sign in again to use another.",
    }
  }
  let signIn = signInsByBlock.get(params.blockId)
  if (signIn?.ctx.configDir !== params.configDir) {
    // A sign-in from before a runbook switch, which forgets the block's
    // sign-in but leaves its dir.
    if (!adoptConfigDir(params.blockId, params.configDir)) {
      return { status: "failed", error: "This sign-in ended when Runbooks quit. Sign in again." }
    }
    const extensionDir =
      params.extensionDir && params.extensionDir !== `${params.configDir}/cliextensions`
        ? params.extensionDir
        : undefined
    signIn = {
      ctx: { configDir: params.configDir, ...(extensionDir ? { extensionDir } : {}) },
      authType: params.authType,
    }
  }
  signInsByBlock.set(params.blockId, signIn)
  const { ctx } = signIn
  try {
    const [accounts, tenants] = await Promise.all([
      runtime.runPromise(listAccounts(ctx)),
      runtime.runPromise(listTenants(ctx)),
    ])
    const options = resolveContextOptions({ accounts, tenants, signedInTenantId: params.tenantId })
    const principal = await pickerPrincipal(ctx, [
      params.tenantId,
      ...options.tenants.map((tenant) => tenant.tenantId),
    ])
    return {
      status: "select_context",
      authType: signIn.authType,
      principal,
      tenants: [...options.tenants],
      subscriptions: [...options.subscriptions],
    }
  } catch (err) {
    return failed(err)
  }
}

const UNREACHABLE =
  /Max retries exceeded|Failed to establish a new connection|Name or service not known|getaddrinfo|ConnectionError|timed out/i

export async function handleValidateSession(params: {
  blockId: string
  configDir: string
  tenantId: string
}): Promise<{ valid: boolean; unreachable?: boolean; ended?: boolean; error?: string }> {
  if (!adoptConfigDir(params.blockId, params.configDir)) {
    return { valid: false, ended: true, error: "the sign-in ended when Runbooks quit" }
  }
  try {
    await runtime.runPromise(principalFor({ configDir: params.configDir }, params.tenantId))
    return { valid: true }
  } catch (err) {
    const error = toErrorMessage(err)
    return { valid: false, error, ...(UNREACHABLE.test(error) ? { unreachable: true } : {}) }
  }
}
