/**
 * The azure:* handlers for electron/main/ipc/azure.ts.
 *
 * Split out of the IPC module so the reply contract can be exercised without
 * an Electron `ipcMain`. None of them rejects: a failure comes back as
 * `{ status: "failed", error }` (or `{ error }`).
 *
 * Every sign-in runs in a config dir main created for the calling block (see
 * ./azure-config-dirs.ts). A finished `az login` is followed by the same
 * steps whatever the method: list the tenants and subscriptions, settle the
 * context (the block's pins, the only option, or the user's pick), read who
 * signed in from a token for that tenant (which is what tells a guest), check
 * the block's required roles, and write the session env.
 */
import { Effect, Stream } from "effect"
import { runtime, sessionManager } from "./runtime.ts"
import {
  abandonConfigDir,
  adoptConfigDir,
  commitConfigDir,
  copyUserConfigDir,
  createConfigDir,
  userAzureExtensionDir,
} from "./azure-config-dirs.ts"
import {
  checkRequiredRoles,
  detectEnvServicePrincipal,
  interactiveLoginArgs,
  listAccounts,
  listTenants,
  loginServicePrincipal,
  missingRolesMessage,
  parseDeviceCodePrompt,
  principalFor,
  resolveContextOptions,
  setSubscription,
  showAccount,
  type AzureSubscription,
  type AzureTenant,
  type DeviceCodePrompt,
} from "../../../src/domain/azure/auth.ts"
import { azErrorLine, spawnAz, type AzContext } from "../../../src/domain/azure/cli.ts"
import { azureSessionEnv, type AzureAuthType } from "../../../src/domain/azure/env.ts"
import { ENV_PREFIX_PATTERN } from "../../../src/domain/env-prefix.ts"
import { redactSecrets, registerSecret } from "../../../src/domain/vcs/redact.ts"
import { errorMessage } from "../../../src/errors/message.ts"
import type { SpawnedProcess } from "../../../src/services/ProcessSpawner.ts"
import type {
  AzureDetectionSourceIpc,
  AzurePrincipalIpc,
  AzureRequiredRoleIpc,
  AzureSignInPinsIpc,
  AzureSignInResultIpc,
  AzureSubscriptionIpc,
  AzureTenantIpc,
} from "../../shared/channels.ts"

const toErrorMessage = (err: unknown): string => redactSecrets(errorMessage(err))

const failed = (err: unknown): AzureSignInResultIpc => ({
  status: "failed",
  error: toErrorMessage(err),
  ...(isCliMissing(err) ? { cliMissing: true } : {}),
})

const isCliMissing = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { cliMissing?: unknown }).cliMissing === true

// ---------------------------------------------------------------------------
// Per-block sign-ins
// ---------------------------------------------------------------------------

/** A block's latest `az login`: what azure:select-context points at a tenant and subscription. */
interface BlockSignIn {
  readonly ctx: AzContext
  readonly authType: AzureAuthType
  readonly clientId?: string | undefined
  readonly clientSecret?: string | undefined
  readonly certificatePath?: string | undefined
}

const signInsByBlock = new Map<string, BlockSignIn>()

/** Forget every block's sign-in at a runbook switch (runbook.ts). */
export function resetAzureSignIns(): void {
  signInsByBlock.clear()
  for (const flow of flows.values()) cancelFlow(flow)
  flows.clear()
}

// ---------------------------------------------------------------------------
// Session env
// ---------------------------------------------------------------------------

/**
 * Write a sign-in's env to the session: set, then delete what it doesn't
 * carry. A failed write is a warning on the success card, not a failed
 * sign-in. Dropped if a different runbook opened since `generation`.
 */
async function applySessionEnv(
  change: ReturnType<typeof azureSessionEnv>,
  generation: number,
): Promise<string | undefined> {
  try {
    await runtime.runPromise(
      sessionManager.appendToEnv(change.set as Record<string, string>, generation),
    )
    if (change.clear.length > 0) {
      await runtime.runPromise(sessionManager.removeFromEnv([...change.clear], generation))
    }
    return undefined
  } catch (err) {
    return `Signed in, but the sign-in could not be saved to the session (${toErrorMessage(err)}). Blocks without azureAuthId may not see it.`
  }
}

// ---------------------------------------------------------------------------
// Finishing a sign-in
// ---------------------------------------------------------------------------

const toTenantIpc = (tenant: AzureTenant): AzureTenantIpc => ({ ...tenant })
const toSubscriptionIpc = (sub: AzureSubscription): AzureSubscriptionIpc => ({
  id: sub.id,
  name: sub.name,
  tenantId: sub.tenantId,
  isDefault: sub.isDefault,
})

/**
 * Point `blockId`'s sign-in at a tenant and subscription and publish it: the
 * principal for that tenant, the required roles, the session env, then the
 * block's config dir is the committed one and older ones are released.
 */
async function commitContext(
  blockId: string,
  signIn: BlockSignIn,
  choice: { tenantId: string; subscriptionId?: string | undefined },
  requiredRoles: readonly AzureRequiredRoleIpc[] | undefined,
  generation: number,
): Promise<AzureSignInResultIpc> {
  const { ctx } = signIn
  const principal = await runtime.runPromise(principalFor(ctx, choice.tenantId))
  if (choice.subscriptionId) {
    await runtime.runPromise(setSubscription(ctx, choice.subscriptionId))
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

  const [accounts, tenants] = await Promise.all([
    runtime.runPromise(listAccounts(ctx)),
    runtime.runPromise(listTenants(ctx)),
  ])
  const subscriptionName = accounts.find((sub) => sub.id === choice.subscriptionId)?.name
  const tenantName = tenants.find(
    (tenant) => tenant.tenantId === choice.tenantId.toLowerCase(),
  )?.displayName

  const change = azureSessionEnv({
    authType: signIn.authType,
    configDir: ctx.configDir,
    extensionDir: ctx.extensionDir,
    principal,
    tenantId: choice.tenantId,
    subscriptionId: choice.subscriptionId,
    clientId: signIn.clientId,
    clientSecret: signIn.clientSecret,
    certificatePath: signIn.certificatePath,
  })

  if (!sessionManager.isCurrentGeneration(generation)) {
    return { status: "failed", error: "A different runbook was opened while signing in" }
  }
  const sessionEnvWarning = await applySessionEnv(change, generation)
  commitConfigDir(blockId, ctx.configDir)

  return {
    status: "authenticated",
    authType: signIn.authType,
    principal: principal as AzurePrincipalIpc,
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
 * After `az login` succeeded in `signIn`'s dir: settle the context from the
 * block's pins, or hand the choice to the user.
 */
async function finishSignIn(
  blockId: string,
  signIn: BlockSignIn,
  pins: AzureSignInPinsIpc,
  generation: number,
): Promise<AzureSignInResultIpc> {
  signInsByBlock.set(blockId, signIn)
  const { ctx } = signIn
  const [accounts, tenants, signedIn] = await Promise.all([
    runtime.runPromise(listAccounts(ctx)),
    runtime.runPromise(listTenants(ctx)),
    runtime.runPromise(showAccount(ctx)),
  ])
  const options = await runtime.runPromise(
    resolveContextOptions({
      accounts,
      tenants,
      ...(signedIn ? { signedInTenantId: signedIn.tenantId } : {}),
      ...(pins.tenantId ? { tenantId: pins.tenantId } : {}),
      ...(pins.subscriptionId ? { subscriptionId: pins.subscriptionId } : {}),
    }),
  )
  if (options.chosen) {
    return commitContext(blockId, signIn, options.chosen, pins.requiredRoles, generation)
  }
  // The principal the picker shows: the token for the tenant az signed in to.
  const principal = await runtime.runPromise(principalFor(ctx, signedIn?.tenantId))
  return {
    status: "select_context",
    authType: signIn.authType,
    principal: principal as AzurePrincipalIpc,
    tenants: options.tenants.map(toTenantIpc),
    subscriptions: options.subscriptions
      .filter((sub) => !pins.tenantId || sub.tenantId === pins.tenantId.toLowerCase())
      .map(toSubscriptionIpc),
  }
}

/** Run `step`; on failure release the uncommitted dir and reply `failed`. */
async function signInOrRelease(
  blockId: string,
  dir: string,
  step: () => Promise<AzureSignInResultIpc>,
): Promise<AzureSignInResultIpc> {
  try {
    const result = await step()
    if (result.status === "failed") abandonConfigDir(blockId, dir)
    return result
  } catch (err) {
    abandonConfigDir(blockId, dir)
    return failed(err)
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function invalidPrefix(prefix: string | undefined): string | undefined {
  if (prefix && !ENV_PREFIX_PATTERN.test(prefix)) {
    return `Invalid env prefix "${prefix}": must match ${ENV_PREFIX_PATTERN}`
  }
  return undefined
}

/**
 * azure:detect — read-only. A service principal in the environment is
 * reported from its names alone (checking it means signing in, which confirm
 * does). An Azure CLI sign-in is checked by getting a token, so an expired
 * one isn't offered.
 */
export async function handleDetect(params: {
  prefix?: string
  sources: AzureDetectionSourceIpc[]
}) {
  const prefixError = invalidPrefix(params.prefix)
  if (prefixError) return { found: false, error: prefixError }

  let lastError: string | undefined
  for (const source of params.sources) {
    try {
      if (source === "env") {
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
      } else {
        // The user's own sign-in, read in place (no config dir of ours).
        const ctx: AzContext = { configDir: "" }
        const account = await runtime.runPromise(showAccount(ctx))
        if (!account) continue
        const principal = await runtime.runPromise(principalFor(ctx))
        return {
          found: true,
          source,
          principalName: principal.name,
          tenantId: account.tenantId,
          ...(account.tenantLevel
            ? {}
            : { subscriptionId: account.id, subscriptionName: account.name }),
        }
      }
    } catch (err) {
      if (isCliMissing(err)) return { found: false, cliMissing: true, error: toErrorMessage(err) }
      lastError = toErrorMessage(err)
    }
  }
  return { found: false, ...(lastError ? { error: lastError } : {}) }
}

/** azure:confirm-detected — sign the block in with what detection found. */
export async function handleConfirmDetected(
  params: AzureSignInPinsIpc & {
    blockId: string
    source: AzureDetectionSourceIpc
    prefix?: string
  },
): Promise<AzureSignInResultIpc> {
  const generation = sessionManager.getGeneration()
  const prefixError = invalidPrefix(params.prefix)
  if (prefixError) return { status: "failed", error: prefixError }

  if (params.source === "cli") {
    let dir: string
    try {
      dir = copyUserConfigDir(params.blockId)
    } catch (err) {
      return failed(err)
    }
    const ctx: AzContext = { configDir: dir, extensionDir: userAzureExtensionDir() }
    return signInOrRelease(params.blockId, dir, () =>
      finishSignIn(params.blockId, { ctx, authType: "cli" }, params, generation),
    )
  }

  const sp = await runtime
    .runPromise(detectEnvServicePrincipal(params.prefix || undefined))
    .catch(() => undefined)
  if (!sp) {
    return { status: "failed", error: "No service principal found in the environment any more" }
  }
  return signInServicePrincipal(
    params.blockId,
    sp,
    {
      ...params,
      ...(params.subscriptionId || sp.subscriptionId
        ? { subscriptionId: params.subscriptionId ?? sp.subscriptionId! }
        : {}),
    },
    generation,
  )
}

// ---------------------------------------------------------------------------
// Service principal
// ---------------------------------------------------------------------------

async function signInServicePrincipal(
  blockId: string,
  creds: {
    clientId: string
    tenantId: string
    clientSecret?: string | undefined
    certificatePath?: string | undefined
  },
  pins: AzureSignInPinsIpc,
  generation: number,
): Promise<AzureSignInResultIpc> {
  if (creds.clientSecret) registerSecret(creds.clientSecret)
  const dir = createConfigDir(blockId)
  const ctx: AzContext = { configDir: dir }
  return signInOrRelease(blockId, dir, async () => {
    await runtime.runPromise(loginServicePrincipal(ctx, creds))
    return finishSignIn(
      blockId,
      {
        ctx,
        authType: "service_principal",
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        certificatePath: creds.certificatePath,
      },
      // A service principal signs in to one tenant: its own.
      { ...pins, tenantId: creds.tenantId },
      generation,
    )
  })
}

/** azure:service-principal */
export async function handleServicePrincipal(
  params: AzureSignInPinsIpc & {
    blockId: string
    clientId: string
    tenantId: string
    clientSecret?: string
    certificatePath?: string
  },
): Promise<AzureSignInResultIpc> {
  const generation = sessionManager.getGeneration()
  if (!params.clientId?.trim() || !params.tenantId?.trim()) {
    return { status: "failed", error: "A client ID and a tenant ID are required" }
  }
  return signInServicePrincipal(
    params.blockId,
    {
      clientId: params.clientId.trim(),
      tenantId: params.tenantId.trim(),
      ...(params.clientSecret ? { clientSecret: params.clientSecret } : {}),
      ...(params.certificatePath ? { certificatePath: params.certificatePath.trim() } : {}),
    },
    params,
    generation,
  )
}

// ---------------------------------------------------------------------------
// Interactive sign-in flows
// ---------------------------------------------------------------------------

/** How long an interactive `az login` may wait for the user. */
const FLOW_TIMEOUT_MS = 15 * 60_000

interface LoginFlow {
  readonly id: string
  readonly blockId: string
  readonly dir: string
  readonly authType: AzureAuthType
  readonly startedAt: number
  readonly generation: number
  readonly process: SpawnedProcess
  readonly stderr: string[]
  prompt?: DeviceCodePrompt | undefined
  exitCode?: number
  /** Set once the flow has finished, so concurrent polls share one finish. */
  result?: Promise<AzureSignInResultIpc>
}

const flows = new Map<string, LoginFlow>()
let nextFlowId = 0

function cancelFlow(flow: LoginFlow): void {
  void runtime.runPromise(flow.process.kill).catch(() => {})
  if (flow.result === undefined) abandonConfigDir(flow.blockId, flow.dir)
}

/** azure:login-start — run `az login` (browser, or device code) in a new config dir. */
export async function handleLoginStart(params: {
  blockId: string
  deviceCode: boolean
  tenantId?: string
}) {
  const generation = sessionManager.getGeneration()
  const dir = createConfigDir(params.blockId)
  const ctx: AzContext = { configDir: dir }
  let process: SpawnedProcess
  try {
    process = await runtime.runPromise(
      spawnAz(ctx, interactiveLoginArgs(params.deviceCode, params.tenantId?.trim() || undefined)),
    )
  } catch (err) {
    abandonConfigDir(params.blockId, dir)
    return { error: toErrorMessage(err), ...(isCliMissing(err) ? { cliMissing: true } : {}) }
  }

  const flow: LoginFlow = {
    id: `azure-login-${++nextFlowId}`,
    blockId: params.blockId,
    dir,
    authType: params.deviceCode ? "device_code" : "cli",
    startedAt: Date.now(),
    generation,
    process,
    stderr: [],
  }
  flows.set(flow.id, flow)

  // Read what az prints (the device code message comes on stderr), and its
  // exit code, as they arrive. Polls read the flow's state.
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
      ),
    )
    .catch(() => {})
  void runtime
    .runPromise(process.exitCode)
    .then((code) => {
      flow.exitCode = code
    })
    .catch(() => {
      flow.exitCode = -1
    })

  return { flowId: flow.id }
}

/** azure:login-poll — pending until `az login` exits; then the sign-in's outcome. */
export async function handleLoginPoll(
  params: AzureSignInPinsIpc & { flowId: string },
): Promise<
  AzureSignInResultIpc | { status: "pending"; verificationUri?: string; userCode?: string }
> {
  const flow = flows.get(params.flowId)
  if (!flow) return { status: "failed", error: "This sign-in is no longer running. Start again." }

  if (flow.exitCode === undefined) {
    if (Date.now() - flow.startedAt > FLOW_TIMEOUT_MS) {
      flows.delete(flow.id)
      cancelFlow(flow)
      return { status: "failed", error: "The sign-in timed out. Start again." }
    }
    return {
      status: "pending",
      ...(flow.prompt
        ? { verificationUri: flow.prompt.verificationUri, userCode: flow.prompt.userCode }
        : {}),
    }
  }

  if (flow.result === undefined) {
    if (flow.exitCode !== 0) {
      abandonConfigDir(flow.blockId, flow.dir)
      flow.result = Promise.resolve({
        status: "failed",
        error: redactSecrets(azErrorLine(flow.stderr)),
      })
    } else {
      flow.result = signInOrRelease(flow.blockId, flow.dir, () =>
        finishSignIn(
          flow.blockId,
          { ctx: { configDir: flow.dir }, authType: flow.authType },
          params,
          flow.generation,
        ),
      )
    }
    void flow.result.finally(() => flows.delete(flow.id))
  }
  return flow.result
}

/** azure:login-cancel */
export function handleLoginCancel(params: { flowId: string }): { ok: true } {
  const flow = flows.get(params.flowId)
  if (flow) {
    flows.delete(flow.id)
    cancelFlow(flow)
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Context and restore
// ---------------------------------------------------------------------------

/** azure:select-context — point the block's latest sign-in at a tenant and subscription. */
export async function handleSelectContext(params: {
  blockId: string
  tenantId: string
  subscriptionId?: string
  requiredRoles?: AzureRequiredRoleIpc[]
}): Promise<AzureSignInResultIpc> {
  const generation = sessionManager.getGeneration()
  const signIn = signInsByBlock.get(params.blockId)
  if (!signIn) return { status: "failed", error: "This block isn't signed in. Sign in again." }
  try {
    return await commitContext(
      params.blockId,
      signIn,
      { tenantId: params.tenantId, subscriptionId: params.subscriptionId },
      params.requiredRoles,
      generation,
    )
  } catch (err) {
    return failed(err)
  }
}

/**
 * azure:validate-session — a restored sign-in still works when its config dir
 * is one main created (this run) and it still gets a token for its tenant.
 */
export async function handleValidateSession(params: {
  blockId: string
  configDir: string
  tenantId: string
}): Promise<{ valid: boolean; error?: string }> {
  if (!adoptConfigDir(params.blockId, params.configDir)) {
    return { valid: false, error: "the sign-in ended when Runbooks quit" }
  }
  try {
    await runtime.runPromise(principalFor({ configDir: params.configDir }, params.tenantId))
    return { valid: true }
  } catch (err) {
    return { valid: false, error: toErrorMessage(err) }
  }
}
