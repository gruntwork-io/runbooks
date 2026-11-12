/**
 * The environment an instance launches with. Without --real-home it carries
 * no cloud or Git host credentials, so a journey can't reach a real account
 * through what happens to be set in the shell that started it.
 */

/** Names that hold a cloud or Git host credential, or say where one is. */
const CREDENTIAL = /^(AWS|AZURE|ARM|CLOUDSDK|GCLOUD|GOOGLE|GH|GITHUB|GITLAB|GLAB)_/

/** `env` with every credential removed. */
export function withoutCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL.test(name)))
}
