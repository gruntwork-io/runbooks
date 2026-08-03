/**
 * Pure parsing/resolution helpers for gcloud's on-disk state.
 *
 * Strings in, objects out — no I/O, no `node:` imports, no SDKs. The layer
 * (`src/layers/GoogleSdkClient.ts`) does every read and hands the raw text
 * here, which is what makes this module exhaustively unit-testable.
 *
 * `ini` is a pure text parser with no ambient behaviour, so importing it from
 * `src/domain` is the same move `github/auth.ts` makes with `yaml`.
 */
import { parse as parseIni } from "ini"
import type {
  AdcInfo,
  GcloudConfiguration,
  GoogleCredentialType,
} from "../../services/GoogleClient.ts"

/** The four paths every gcloud config root contains. */
export interface GcloudConfigPaths {
  readonly root: string
  readonly activeConfigFile: string
  readonly configurationsDir: string
  readonly adcFile: string
}

/** The subset of a `config_<name>` file the block cares about. */
export interface GcloudConfigFields {
  readonly account?: string
  readonly project?: string
  readonly region?: string
  readonly zone?: string
}

/** Every path under the root is built with the target platform's separator. */
const separatorFor = (platform: string): string => (platform === "win32" ? "\\" : "/")

/** Drop trailing separators so `join` never produces a doubled one. */
function trimTrailingSeparators(value: string): string {
  let end = value.length
  while (end > 1 && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1
  return value.slice(0, end)
}

/**
 * The gcloud config root.
 *
 * `CLOUDSDK_CONFIG`, when SET, is authoritative: a set-but-empty value means
 * "this machine has no gcloud config", never "fall through to
 * ~/.config/gcloud" — falling through would read a config the user explicitly
 * turned off. Windows' base is `%APPDATA%\gcloud`, NOT `%LOCALAPPDATA%`.
 */
function resolveConfigRoot(
  env: Record<string, string | undefined>,
  homeDir: string,
  platform: string,
): string {
  const override = env.CLOUDSDK_CONFIG
  if (override !== undefined) return trimTrailingSeparators(override.trim())

  const sep = separatorFor(platform)

  if (platform === "win32") {
    const appData = env.APPDATA?.trim()
    if (appData) return `${trimTrailingSeparators(appData)}${sep}gcloud`
    if (!homeDir) return ""
    return [trimTrailingSeparators(homeDir), "AppData", "Roaming", "gcloud"].join(sep)
  }

  if (!homeDir) return ""
  return [trimTrailingSeparators(homeDir), ".config", "gcloud"].join(sep)
}

/**
 * Resolve the gcloud config root and the three well-known paths beneath it.
 *
 * An unresolvable root yields empty paths rather than relative ones: a relative
 * `configurations` would be read against the process' working directory, which
 * is never what the caller meant. Every read of an empty path fails with
 * ENOENT, which the layer already treats as "no gcloud config".
 */
export function resolveGcloudConfigPaths(
  env: Record<string, string | undefined>,
  homeDir: string,
  platform: string,
): GcloudConfigPaths {
  const root = resolveConfigRoot(env, homeDir, platform)
  if (!root) {
    return { root: "", activeConfigFile: "", configurationsDir: "", adcFile: "" }
  }

  const sep = separatorFor(platform)
  return {
    root,
    activeConfigFile: `${root}${sep}active_config`,
    configurationsDir: `${root}${sep}configurations`,
    adcFile: `${root}${sep}application_default_credentials.json`,
  }
}

/** A non-empty trimmed string, or undefined. Keeps blank ini values out. */
function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** One `[section]` of a parsed ini file, when it is a section at all. */
function iniSection(parsed: Record<string, unknown>, name: string): Record<string, unknown> {
  const section = parsed[name]
  return typeof section === "object" && section !== null && !Array.isArray(section)
    ? (section as Record<string, unknown>)
    : {}
}

/**
 * `config_<name>` ini text -> the fields the block reads:
 * `core.account`, `core.project`, `compute.region`, `compute.zone`.
 *
 * Missing sections and missing keys are simply absent from the result (the
 * conditional-spread idiom), never present-but-undefined.
 */
export function parseGcloudConfiguration(iniText: string): GcloudConfigFields {
  let parsed: Record<string, unknown>
  try {
    parsed = parseIni(iniText) as Record<string, unknown>
  } catch {
    // A corrupt configuration reads as an empty one rather than failing the
    // whole listing.
    return {}
  }

  const core = iniSection(parsed, "core")
  const compute = iniSection(parsed, "compute")

  const account = cleanString(core.account)
  const project = cleanString(core.project)
  const region = cleanString(compute.region)
  const zone = cleanString(compute.zone)

  return {
    ...(account ? { account } : {}),
    ...(project ? { project } : {}),
    ...(region ? { region } : {}),
    ...(zone ? { zone } : {}),
  }
}

/**
 * How usable a configuration is, given the Application Default Credentials
 * that back it.
 *
 * One ADC document backs every configuration — gcloud keeps its CLI
 * credentials in a SQLite `credentials.db` that is not a supportable
 * credential source — so a configuration without ADC is a set of settings with
 * nothing to authenticate as.
 */
export function classifyGcloudConfig(
  fields: GcloudConfigFields,
  adc?: AdcInfo,
): GcloudConfiguration["authType"] {
  if (adc) {
    switch (adc.type) {
      case "authorized_user":
        return "adc-user"
      case "service_account":
        return "adc-service-account"
      case "external_account":
      case "impersonated_service_account":
        return "adc-external"
      default:
        // access_token / gce_metadata have no file form: an ADC document can
        // never legitimately carry one.
        return "unsupported"
    }
  }
  return fields.project ? "config-only" : "unsupported"
}

/**
 * Narrow a credentials document's `type` onto the service's union.
 *
 * `external_account_authorized_user` is what workforce/workload pools hand
 * out; it authenticates exactly like an external account.
 */
function credentialTypeFromDocumentType(type: unknown): GoogleCredentialType {
  switch (type) {
    case "service_account":
    case "authorized_user":
    case "external_account":
    case "impersonated_service_account":
      return type
    case "external_account_authorized_user":
      return "external_account"
    default:
      throw new Error(
        `Unsupported Google credentials type: ${typeof type === "string" ? type : "(missing)"}`,
      )
  }
}

/**
 * A credentials JSON document -> metadata ONLY.
 *
 * The return type has no field that could hold `private_key`,
 * `client_secret`, or `refresh_token`, and this function reads none of them.
 * Throws on unparseable or unsupported documents; the caller decides whether
 * that means "no ADC" or "this file is broken".
 *
 * The thrown messages are deliberately content-free: `JSON.parse` quotes the
 * offending text, and for a credentials document that text IS the secret.
 */
export function parseAdcDocument(filePath: string, jsonText: string): AdcInfo {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error(`${filePath} is not valid JSON`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} is not a JSON object`)
  }

  const doc = parsed as Record<string, unknown>
  const type = credentialTypeFromDocumentType(doc.type)
  const clientEmail = cleanString(doc.client_email)
  const quotaProjectId = cleanString(doc.quota_project_id)

  return {
    path: filePath,
    type,
    ...(clientEmail ? { clientEmail } : {}),
    ...(quotaProjectId ? { quotaProjectId } : {}),
  }
}

/**
 * The active configuration's name: `CLOUDSDK_ACTIVE_CONFIG_NAME` wins, then
 * the trimmed contents of `active_config`, then gcloud's own default.
 */
export function resolveActiveConfigName(
  env: Record<string, string | undefined>,
  activeConfigFileText: string | undefined,
): string {
  const fromEnv = cleanString(env.CLOUDSDK_ACTIVE_CONFIG_NAME)
  if (fromEnv) return fromEnv

  const fromFile = cleanString(activeConfigFileText)
  if (fromFile) return fromFile

  return "default"
}
