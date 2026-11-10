/**
 * The Google APIs a <TfModule> block needs turned on in the signed-in
 * project: the ones the module's resources call, which runbook_block.yml
 * lists under requires.google.apis, and the ones its lookups call. A block
 * checks them before it plans, so a missing API shows up with a link that
 * turns it on rather than as a failed lookup or plan.
 */
import { isLookupName, type LookupName } from "./lookups.ts"
import type { TfModuleSpec } from "./types.ts"

/** The API each lookup calls, when it calls one. */
const LOOKUP_APIS: Readonly<Record<LookupName, string | undefined>> = {
  "google.me": undefined,
  "google.domains": "admin.googleapis.com",
  "google.people": "admin.googleapis.com",
}

/** Names people know APIs by in the Cloud console. Others show their service name. */
const API_NAMES: Readonly<Record<string, string>> = {
  "admin.googleapis.com": "Admin SDK API",
  "cloudidentity.googleapis.com": "Cloud Identity API",
  "cloudresourcemanager.googleapis.com": "Cloud Resource Manager API",
  "compute.googleapis.com": "Compute Engine API",
  "iam.googleapis.com": "Identity and Access Management (IAM) API",
  "people.googleapis.com": "People API",
  "serviceusage.googleapis.com": "Service Usage API",
  "storage.googleapis.com": "Cloud Storage API",
}

export interface RequiredApi {
  /** The service name, such as cloudidentity.googleapis.com. */
  readonly service: string
  readonly name: string
  /**
   * `apply` when the module's resources call it, so a plan fails without it;
   * `suggestions` when only a lookup does, so the form still takes typed values.
   */
  readonly neededFor: "apply" | "suggestions"
}

/** The APIs the block needs: the module's first, then its lookups' that the module doesn't need. */
export function requiredApis(spec: TfModuleSpec): RequiredApi[] {
  const apis: RequiredApi[] = spec.googleApis.map((service) => ({
    service,
    name: apiName(service),
    neededFor: "apply",
  }))
  for (const variable of spec.variables) {
    for (const from of [variable.lookup?.from, variable.shortcut?.from]) {
      const service = from !== undefined && isLookupName(from) ? LOOKUP_APIS[from] : undefined
      if (service && !apis.some((api) => api.service === service)) {
        apis.push({ service, name: apiName(service), neededFor: "suggestions" })
      }
    }
  }
  return apis
}

export function apiName(service: string): string {
  return API_NAMES[service] ?? service
}

/** The Cloud console page that turns the API on in the project. */
export function enableApiUrl(service: string, project: string): string {
  return `https://console.cloud.google.com/apis/library/${encodeURIComponent(service)}?project=${encodeURIComponent(project)}`
}
