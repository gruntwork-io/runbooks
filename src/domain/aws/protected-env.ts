/**
 * AWS credential protection for runbooks that contain an <AwsAuth> block.
 *
 * Such a runbook asks for explicit credential management, so AWS keys the app
 * inherited (a terminal's exports, or rc-file exports loaded by shell-env)
 * must not reach any script until the user confirms an account in the block.
 * The session strips these vars at creation; confirming re-adds them.
 */
import { parseComponents } from "../registry/executable.ts"

/** The AWS credential vars stripped from a session whose runbook has <AwsAuth>. */
export const AWS_PROTECTED_ENV_VARS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const

/**
 * The env vars a new session for this runbook must strip: the AWS credential
 * vars when `content` has an <AwsAuth> block outside fenced code (a documented
 * example doesn't count), and none otherwise.
 */
export function protectedEnvVarsForRunbook(content: string): string[] {
  return parseComponents(content, "AwsAuth").length > 0
    ? [...AWS_PROTECTED_ENV_VARS]
    : []
}
