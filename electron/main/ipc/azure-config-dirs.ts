import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const createdDirs = new Set<string>()
const dirsByBlock = new Map<string, string[]>()
const committedByBlock = new Map<string, string>()

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

const userAzureConfigDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.AZURE_CONFIG_DIR || path.join(os.homedir(), ".azure")

export function userAzureExtensionDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.AZURE_EXTENSION_DIR || path.join(userAzureConfigDir(env), "cliextensions")
  return fs.existsSync(dir) ? dir : undefined
}

export function hasUserAzureSignIn(): boolean {
  return fs.existsSync(path.join(userAzureConfigDir(), "azureProfile.json"))
}

export function createConfigDir(blockId: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-azure-"))
  try {
    fs.chmodSync(dir, 0o700)
  } catch {}
  createdDirs.add(dir)
  dirsByBlock.set(blockId, [...(dirsByBlock.get(blockId) ?? []), dir])
  return dir
}

export function copyUserConfigDir(
  blockId: string,
  sourceDir: string = userAzureConfigDir(),
): string {
  if (!fs.existsSync(path.join(sourceDir, "azureProfile.json"))) {
    throw new Error(`No Azure CLI sign-in in ${sourceDir}. Run az login, or sign in here.`)
  }
  const dir = createConfigDir(blockId)
  for (const name of SIGN_IN_FILES) {
    const from = path.join(sourceDir, name)
    if (!fs.existsSync(from)) continue
    const to = path.join(dir, name)
    fs.copyFileSync(from, to)
    try {
      fs.chmodSync(to, 0o600)
    } catch {}
  }
  return dir
}

export function adoptConfigDir(blockId: string, dir: string): boolean {
  if (!createdDirs.has(dir) || !fs.existsSync(dir)) return false
  const dirs = dirsByBlock.get(blockId) ?? []
  if (!dirs.includes(dir)) dirsByBlock.set(blockId, [...dirs, dir])
  return true
}

function releaseDir(dir: string): void {
  if (!createdDirs.has(dir)) return
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    createdDirs.delete(dir)
  } catch {}
}

export function commitConfigDir(blockId: string, dir: string): void {
  committedByBlock.set(blockId, dir)
  const committedElsewhere = new Set(
    [...committedByBlock].filter(([other]) => other !== blockId).map(([, d]) => d),
  )
  for (const other of dirsByBlock.get(blockId) ?? []) {
    if (other !== dir && !committedElsewhere.has(other)) releaseDir(other)
  }
  dirsByBlock.set(blockId, [dir])
}

export function abandonConfigDir(blockId: string, dir: string): void {
  if (committedByBlock.get(blockId) === dir) return
  releaseDir(dir)
  dirsByBlock.set(
    blockId,
    (dirsByBlock.get(blockId) ?? []).filter((d) => d !== dir),
  )
}

export function resetAzureConfigDirRegistry(): void {
  dirsByBlock.clear()
  committedByBlock.clear()
}

export function cleanupAzureConfigDirs(): void {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  createdDirs.clear()
  resetAzureConfigDirRegistry()
}
