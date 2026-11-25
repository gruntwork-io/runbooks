/**
 * The session store over an in-memory database and the test cipher. A test
 * that restarts the engine passes the same database to each start, as the
 * app reopens the same file.
 */
import { Layer } from "effect"
import { SessionStore } from "../engine/sessionStore.ts"
import { type TestCipherOptions, testSessionCipher } from "./TestSessionCipher.ts"
import { type MemorySessionDatabase, memorySessionDatabase } from "./TestSessionDatabase.ts"

export const testSessionStore = (
  options: { readonly database?: MemorySessionDatabase; readonly cipher?: TestCipherOptions } = {},
): Layer.Layer<SessionStore> =>
  SessionStore.layer.pipe(
    Layer.provide(
      Layer.merge(
        (options.database ?? memorySessionDatabase()).layer,
        testSessionCipher(options.cipher),
      ),
    ),
  )
