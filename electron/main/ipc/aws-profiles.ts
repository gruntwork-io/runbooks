/**
 * The aws:profiles and aws:profile-auth handlers for electron/main/ipc/aws.ts.
 *
 * Split out of the IPC module so the reply contract can be exercised without
 * an Electron `ipcMain`. aws:profiles replies `{ profiles }`, the shape
 * useAwsAuth reads and electron/shared/channels.ts declares.
 */
import { runtime } from "./runtime.ts"
import {
  validateCredentials,
  listProfiles,
  authenticateProfile,
} from "../../../src/domain/aws/auth.ts"

export type ProfileAuthRequest = { profileName?: string; profile?: string }

/** aws:profiles — every profile in the local AWS config and credentials files. */
export async function handleProfiles() {
  return { profiles: await runtime.runPromise(listProfiles()) }
}

/**
 * aws:profile-auth — resolve the profile's credentials, then validate them
 * once via STS. Never rejects: a failure comes back as `{valid:false, error}`.
 */
export async function handleProfileAuth(params: ProfileAuthRequest) {
  const profileName = params.profileName ?? params.profile ?? ""
  try {
    const credentials = await runtime.runPromise(authenticateProfile(profileName))
    const identity = await runtime.runPromise(validateCredentials(credentials))
    return {
      valid: true,
      ...identity,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      region: credentials.region,
    }
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
