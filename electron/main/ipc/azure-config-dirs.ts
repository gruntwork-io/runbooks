/**
 * Custody of the Azure CLI config dirs main creates for AzureAuth blocks.
 *
 * Every sign-in gets its own `AZURE_CONFIG_DIR`, so two AzureAuth blocks (one
 * per tenant, say) never share or overwrite a sign-in, and a block never
 * changes the user's own `~/.azure`. Reusing the user's existing `az login`
 * copies its token cache into the block's dir; the copy then lives (and
 * refreshes) on its own.
 *
 * Like ./google-credentials.ts: a module-level registry of every dir this
 * process created, released when its block commits a newer one, and swept at
 * quit. A runbook switch forgets the bookkeeping but leaves the dirs (a step
 * from the previous runbook may still be running in one) to the sweep.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/** Dirs this process created, newest last per block. */
const createdDirs = new Set<string>()

/** blockId -> dirs the block signed in to, oldest first. The last is the newest. */
const dirsByBlock = new Map<string, string[]>()

/** blockId -> the dir the block's published outputs name. */
const committedByBlock = new Map<string, string>()

const BLOCKLESS_KEY = " blockless"
const keyFor = (blockId: string | undefined) => blockId || BLOCKLESS_KEY

/**
 * The files of an Azure CLI config dir that hold a sign-in: the profile
 * (accounts and subscriptions), MSAL's token caches (plain JSON, or the .bin
 * that's encrypted for this OS user on Windows), service principal entries,
 * the cloud and the CLI config.
 */
const SIGN_IN_FILES = [
  "azureProfile.json",
  "msal_token_cache.json",
  "msal_token_cache.bin",
  "msal_http_cache.bin",
  "service_principal_entries.json",
  "service_principal_entries.bin",
  "clouds.config",
  "config",
] as const

/** The user's own Azure CLI config dir: AZURE_CONFIG_DIR, else ~/.azure. */
export function userAzureConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AZURE_CONFIG_DIR || path.join(os.homedir(), ".azure")
}

/** The user's extension dir, when it exists, so a copied sign-in keeps their `az` extensions. */
export function userAzureExtensionDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.AZURE_EXTENSION_DIR || path.join(userAzureConfigDir(env), "cliextensions")
  return fs.existsSync(dir) ? dir : undefined
}

/** Create a private, empty config dir for one sign-in of `blockId`. */
export function createConfigDir(blockId: string | undefined): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-azure-"))
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // No-op on Windows; the per-user temp root's ACL protects it there.
  }
  createdDirs.add(dir)
  const key = keyFor(blockId)
  dirsByBlock.set(key, [...(dirsByBlock.get(key) ?? []), dir])
  return dir
}

/**
 * Create a config dir for `blockId` holding a copy of the sign-in in
 * `sourceDir` (the user's own, by default). Fails when there's no sign-in to
 * copy.
 */
export function copyUserConfigDir(
  blockId: string | undefined,
  sourceDir: string = userAzureConfigDir(),
): string {
  if (!fs.existsSync(path.join(sourceDir, "azureProfile.json"))) {
    throw new Error(`No Azure CLI sign-in in ${sourceDir}. Run az login, or sign in here.`)
  }
  const dir = createConfigDir(blockId)
  for (const name of SIGN_IN_FILES) {
    const from = path.join(sourceDir, name)
    if (!fs.existsSync(from)) continue
    fs.copyFileSync(from, path.join(dir, name))
    try {
      fs.chmodSync(path.join(dir, name), 0o600)
    } catch {
      // No-op on Windows.
    }
  }
  return dir
}

/**
 * Take `dir` back as `blockId`'s, when a session restores the block's sign-in.
 * Only a dir this process created and hasn't released qualifies: the renderer
 * names it, and az must never be pointed at a dir main doesn't own. After an
 * app restart there are none (the quit sweep removed them).
 */
export function adoptConfigDir(blockId: string | undefined, dir: string): boolean {
  if (!createdDirs.has(dir) || !fs.existsSync(dir)) return false
  const key = keyFor(blockId)
  const dirs = dirsByBlock.get(key) ?? []
  if (!dirs.includes(dir)) dirsByBlock.set(key, [...dirs, dir])
  return true
}

function releaseDir(dir: string): void {
  if (!createdDirs.has(dir)) return
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Best effort: the quit sweep tries again.
    return
  }
  createdDirs.delete(dir)
}

/**
 * `blockId` now publishes `dir`: release every other dir it signed in to, so
 * a superseded sign-in's tokens don't stay on disk. A dir another block has
 * committed is left to the quit sweep.
 */
export function commitConfigDir(blockId: string | undefined, dir: string): void {
  const key = keyFor(blockId)
  committedByBlock.set(key, dir)
  const committedElsewhere = new Set(
    [...committedByBlock].filter(([other]) => other !== key).map(([, d]) => d),
  )
  const kept: string[] = []
  for (const other of dirsByBlock.get(key) ?? []) {
    if (other === dir) kept.push(other)
    else if (!committedElsewhere.has(other)) releaseDir(other)
  }
  dirsByBlock.set(key, kept)
}

/**
 * Release a dir a flow created but never committed (a cancelled or failed
 * sign-in). The block's committed dir is never released here.
 */
export function abandonConfigDir(blockId: string | undefined, dir: string): void {
  const key = keyFor(blockId)
  if (committedByBlock.get(key) === dir) return
  releaseDir(dir)
  dirsByBlock.set(
    key,
    (dirsByBlock.get(key) ?? []).filter((d) => d !== dir),
  )
}

/** Forget all bookkeeping at a runbook switch. The dirs stay until the quit sweep. */
export function resetAzureConfigDirRegistry(): void {
  dirsByBlock.clear()
  committedByBlock.clear()
}

/** Remove every dir this process created. Runs at `will-quit`. */
export function cleanupAzureConfigDirs(): void {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort
    }
  }
  createdDirs.clear()
  dirsByBlock.clear()
  committedByBlock.clear()
}
