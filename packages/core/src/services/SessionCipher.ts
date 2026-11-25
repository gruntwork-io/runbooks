/**
 * Encrypts what a saved session holds before it reaches the sessions
 * database, with a key the system keeps: Keychain on macOS, DPAPI on
 * Windows, a secret service on Linux. The app's layer, over Electron's
 * `safeStorage`, comes with the app's main (phase 5); tests use
 * `../test-utils/TestSessionCipher.ts`.
 *
 * Form values, outputs, logs and credentials can each hold a secret, so the
 * session store encrypts every payload, and saves none the system cannot
 * encrypt.
 */
import { Context, type Effect, type Option, type Redacted } from "effect"

export interface SessionCipherShape {
  /**
   * None when the system offers no encryption now: no key store, a Linux
   * fallback key that protects nothing, or a person who refused the
   * system's prompt.
   */
  readonly encrypt: (
    plaintext: Redacted.Redacted<string>,
  ) => Effect.Effect<Option.Option<Uint8Array>>
  /** None when `ciphertext` cannot be decrypted: the system's key changed, or another machine wrote it. */
  readonly decrypt: (
    ciphertext: Uint8Array,
  ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>
}

export class SessionCipher extends Context.Service<SessionCipher, SessionCipherShape>()(
  "@runbooks/core/services/SessionCipher",
) {}
