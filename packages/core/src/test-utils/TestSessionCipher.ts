/**
 * A `SessionCipher` for tests. It scrambles each byte under a numbered key,
 * so a secret shows in the database only if the store skipped encryption.
 * A cipher with another key cannot decrypt it, as after the system's key
 * changes; one made `unavailable` encrypts nothing, as on a machine with no
 * key store.
 */
import { Effect, Layer, Option, Redacted } from "effect"
import { SessionCipher } from "../services/SessionCipher.ts"

const MARK = 0xec

const scramble = (key: number, i: number): number => (key * 31 + i * 7 + 13) & 0xff

/** What the test cipher with `key` makes of `plaintext`: for a row a test writes as an older or newer version would. */
export function testCiphertext(plaintext: string, key = 1): Uint8Array {
  const bytes = new TextEncoder().encode(plaintext)
  return Uint8Array.from([MARK, key, ...bytes.map((byte, i) => byte ^ scramble(key, i))])
}

/** What a payload the test cipher with `key` encrypted holds, for a test that looks inside one. */
export function testPlaintext(ciphertext: Uint8Array, key = 1): Option.Option<string> {
  if (ciphertext[0] !== MARK || ciphertext[1] !== key) return Option.none()
  const bytes = ciphertext.subarray(2).map((byte, i) => byte ^ scramble(key, i))
  try {
    return Option.some(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return Option.none()
  }
}

export interface TestCipherOptions {
  /** Which key it encrypts and decrypts with. 1 unless given. */
  readonly key?: number
  /** False for a system with no encryption: `encrypt` gives none. */
  readonly available?: boolean
}

export const testSessionCipher = (options: TestCipherOptions = {}): Layer.Layer<SessionCipher> => {
  const key = options.key ?? 1
  return Layer.succeed(
    SessionCipher,
    SessionCipher.of({
      encrypt: (plaintext) =>
        Effect.sync(() =>
          options.available === false
            ? Option.none()
            : Option.some(testCiphertext(Redacted.value(plaintext), key)),
        ),
      decrypt: (ciphertext) =>
        Effect.sync(() => Option.map(testPlaintext(ciphertext, key), Redacted.make)),
    }),
  )
}
