import { useRunbookContext } from "@/contexts/useRunbook"

/**
 * Who's signed in to Google, and to which project, as GoogleAuth blocks
 * published it: a key that changes on each sign-in, so answers that came from
 * Google can be asked for again.
 */
export function useGoogleSignIns(): string {
  const { blockOutputs } = useRunbookContext()
  return JSON.stringify(
    Object.values(blockOutputs)
      .filter((outputs) => outputs.values.GOOGLE_AUTH_TYPE !== undefined)
      .map((outputs) => [
        outputs.values.CLOUDSDK_CORE_ACCOUNT,
        outputs.values.GOOGLE_CLOUD_PROJECT,
        outputs.timestamp,
      ]),
  )
}
