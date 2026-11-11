/**
 * What a <TfModule> block's readiness check means for the user: each thing
 * missing, with its fix, and what's in place. The block shows the problems
 * with their fixes, or one line of what's ready.
 */
import { enableApiUrl, type RequiredApi } from "../../../../../src/domain/tf-module/requirements"
import type { TfModuleReadiness } from "../../../../../electron/shared/channels"

export interface ReadinessProblem {
  readonly key: string
  readonly text: string
  readonly fix?: { readonly label: string; readonly url: string }
}

export interface ReadinessReport {
  readonly problems: readonly ReadinessProblem[]
  /** What's in place, such as "OpenTofu 1.12.6", when nothing's missing. */
  readonly ready: readonly string[]
}

const TOOL_NAMES: Readonly<Record<string, string>> = {
  tofu: "OpenTofu",
  terraform: "Terraform",
  terragrunt: "Terragrunt",
}

export function readinessReport(
  apis: readonly RequiredApi[],
  readiness: TfModuleReadiness,
): ReadinessReport {
  const problems: ReadinessProblem[] = []
  const ready: string[] = []
  const applyNeedsGoogle = apis.some((api) => api.neededFor === "apply")
  const { google } = readiness

  switch (google.kind) {
    case "none":
      break
    case "signed-out":
      // The lookups say so themselves; only the apply's APIs need it said here.
      if (applyNeedsGoogle) {
        problems.push({
          key: "google",
          text: "Sign in with a GoogleAuth block above, so the block can check the project's Google APIs.",
        })
      }
      break
    case "no-project":
      problems.push({
        key: "google",
        text: "Pick a project in the GoogleAuth block above. Google bills this block's API calls to it.",
      })
      break
    case "error":
      problems.push({
        key: "google",
        text: `Couldn't check the Google APIs in ${google.project}: ${google.message}`,
      })
      break
    case "checked": {
      const off = apis.filter((api) => google.enabled[api.service] === false)
      for (const api of off) {
        problems.push({
          key: api.service,
          text:
            api.neededFor === "apply"
              ? `The ${api.name} is off in ${google.project}, and the plan needs it.`
              : `The ${api.name} is off in ${google.project}, so its suggestions won't load. Typed values still work.`,
          fix: { label: "Turn it on", url: enableApiUrl(api.service, google.project) },
        })
      }
      const on = apis.length - off.length
      ready.push(`${on} Google ${on === 1 ? "API" : "APIs"} on in ${google.project}`)
      break
    }
  }

  for (const tool of readiness.tools) {
    const name = TOOL_NAMES[tool.command] ?? tool.command
    if (tool.found) {
      ready.push(tool.version ? `${name} ${tool.version}` : name)
    } else {
      problems.push({
        key: tool.command,
        text: `${name} isn't on your PATH, and the plan runs it.`,
        fix: { label: `Install ${name}`, url: tool.install },
      })
    }
  }

  return { problems, ready: problems.length > 0 ? [] : ready }
}
