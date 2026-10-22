import { useProgressStep } from "../hooks/useProgressStep"

/**
 * Counts the block that renders it as one step of the runbook's progress
 * bar, for as long as it is rendered. Renders nothing. A block renders it
 * with its working UI, not with an error shown in its place.
 */
export function ProgressStep({ done }: { done: boolean }) {
  useProgressStep(done)
  return null
}
