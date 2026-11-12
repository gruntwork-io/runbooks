/**
 * In simulation mode, nothing reaches a real system unless the runbook's
 * simulation.yml says so.
 *
 * Every IPC channel that signs in, calls a cloud or Git host's API, runs a
 * script, or pushes is listed here, and in simulation mode a call to one is
 * refused before its handler runs, unless the simulation answers it. A
 * channel whose handler answers from simulation.yml itself, such as the
 * <TerragruntApply> block's, isn't listed. So a block nobody taught about
 * simulation can't reach a real system: it gets an error saying why.
 *
 * Only `import type` from electron, so this stays unit-testable without an
 * Electron runtime (same approach as ipc-sender.ts).
 */
import type { IpcMain } from "electron"

/** What each channel that reaches a real system does, as a refusal names it. */
export const REAL_CHANNELS: Readonly<Record<string, string>> = {
  "exec:run": "run a block's script",
  "aws:validate": "sign in to AWS",
  "aws:profile-auth": "sign in to AWS",
  "aws:sso-start": "sign in to AWS",
  "aws:sso-poll": "sign in to AWS",
  "aws:sso-roles": "sign in to AWS",
  "aws:sso-complete": "sign in to AWS",
  "aws:env-credentials": "sign in to AWS",
  "aws:env-credentials-confirm": "sign in to AWS",
  "aws:check-region": "call AWS",
  "aws:send": "call AWS",
  "google:validate-credentials": "sign in to Google Cloud",
  "google:oauth-start": "sign in to Google Cloud",
  "google:oauth-poll": "sign in to Google Cloud",
  "google:gcloud-auth": "sign in to Google Cloud",
  "google:env-credentials": "sign in to Google Cloud",
  "google:env-credentials-confirm": "sign in to Google Cloud",
  "google:projects": "call Google Cloud",
  "google:set-project": "call Google Cloud",
  "google:check-project": "call Google Cloud",
  "google:send": "call Google Cloud",
  "github:validate": "sign in to GitHub",
  "github:oauth-start": "sign in to GitHub",
  "github:oauth-poll": "sign in to GitHub",
  "github:env-credentials": "sign in to GitHub",
  "github:cli-credentials": "sign in to GitHub",
  "github:orgs": "call GitHub",
  "github:repos": "call GitHub",
  "github:refs": "call GitHub",
  "github:labels": "call GitHub",
  "gitlab:validate": "sign in to GitLab",
  "gitlab:env-credentials": "sign in to GitLab",
  "gitlab:cli-credentials": "sign in to GitLab",
  "gitlab:labels": "call GitLab",
  "git:clone": "clone a repository",
  "git:push": "push to a repository",
  "git:pull-request": "open a pull request",
  "git:merge-request": "open a merge request",
}

/**
 * Why a call can't run, or nothing when it can. Called for every call to a
 * channel in REAL_CHANNELS, with the call's arguments.
 */
export type SimulationCheck = (
  channel: string,
  args: readonly unknown[],
) => Promise<string | undefined> | string | undefined

const guardedIpcs = new WeakSet<object>()

/**
 * Wrap `ipc.handle` so every handler registered through it afterwards for a
 * channel in REAL_CHANNELS first asks `check`, and rejects the call without
 * running when `check` gives a reason. Must run before the first
 * `ipcMain.handle` call. Installing it again is a no-op.
 */
export function installSimulationGuard(ipc: Pick<IpcMain, "handle">, check: SimulationCheck): void {
  if (guardedIpcs.has(ipc)) return
  guardedIpcs.add(ipc)
  const register = ipc.handle.bind(ipc)
  ipc.handle = (channel, listener) => {
    if (!Object.hasOwn(REAL_CHANNELS, channel)) return register(channel, listener)
    return register(channel, async (event, ...args) => {
      const refusal = await check(channel, args)
      if (refusal) throw new Error(refusal)
      return listener(event, ...args)
    })
  }
}

/** The refusal for a channel in simulation mode, when the simulation doesn't answer it. */
export const simulationRefusal = (channel: string) =>
  `Simulation mode doesn't ${REAL_CHANNELS[channel] ?? "reach real systems"}: nothing in a simulation reaches a real system unless simulation.yml says so.`
