/**
 * The fake credential provider's script for each provider a credential
 * block names, by provider name (`fakeCredentialProviders`): what
 * `runbooks test` and the app's dev mode sign credential blocks in with
 * until the plugin transport runs the real providers. Nothing here starts a
 * binary. One line per provider, beside its block:
 *
 *   aws: AWS_FAKE,
 */
import type { FakeScript } from "@runbooks/core/credential/fake"

export const fakeScripts: { readonly [provider: string]: FakeScript } = {}
