/**
 * AWS credential protection for runbooks that contain an <AwsAuth> block.
 *
 * Such a runbook asks for explicit credential management, so AWS keys the app
 * inherited (a terminal's exports, or rc-file exports loaded by shell-env)
 * must not reach any script until the user confirms an account in the block.
 * The session strips these vars at creation; confirming re-adds them.
 */
import { parseMdx } from "../../mdx.ts"

/** The AWS credential vars stripped from a session whose runbook has <AwsAuth>. */
export const AWS_PROTECTED_ENV_VARS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const

/**
 * The env vars a new session for this runbook must strip: the AWS credential
 * vars when `content` has an <AwsAuth> block (a documented example in a code
 * fence doesn't count), and none otherwise.
 *
 * A runbook the renderer refuses, because it isn't valid MDX or has code in it,
 * shows no blocks, but the session outlives a watch-mode fix to it, so it
 * counts as having the block if `<AwsAuth` appears anywhere in it.
 */
export function protectedEnvVarsForRunbook(content: string): string[] {
  const parsed = parseMdx(content)
  const hasAwsAuth = parsed.ok
    ? parsed.elements.some((element) => element.name === "AwsAuth")
    : content.includes("<AwsAuth")
  return hasAwsAuth ? [...AWS_PROTECTED_ENV_VARS] : []
}
