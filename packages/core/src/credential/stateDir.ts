/**
 * A credential block's state directory, in its session's state folder
 * (`stateDirOf`): where its provider keeps the files it writes. The plan's third secret
 * rule puts a credential that can live in a file there, readable by its
 * owner only. The engine makes the directory before it opens the provider,
 * so a plugin that writes there, and one that only checks it is there,
 * both find it owner-only.
 *
 * Built on open decision 15 (Windows) as "leave it as it is": Windows
 * keeps no permission bits, so there a directory or file counts as
 * owner-only, and the plugins set no ACLs either. Were Windows supported,
 * the check would read the ACL instead.
 */
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Option } from "effect"
import { type BlockId, CredentialError } from "@runbooks/blocks-core/contract"
import { FileSystem } from "../services/FileSystem.ts"

/**
 * The state folder of block `id` in its session's `sessionFolder`: the id
 * lowercased, then the first 12 hex digits of the id's SHA-256. Ids that
 * differ only in case are two blocks, and a file system that ignores case
 * (macOS's default) would give them one folder if the id alone named it, so
 * one block's sign-out would delete the other's files. A block id is an
 * `ID_WORD`, so the name holds no separator and the folder is always the
 * session folder's own.
 */
export const stateDirOf = (sessionFolder: string, id: BlockId): string =>
  path.join(
    sessionFolder,
    `${id.toLowerCase()}-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`,
  )

/** Owner only: read, write and enter. Recursive creation gives the session's folder the same. */
const STATE_DIR_MODE = 0o700

/** Whether a path with these permission bits is closed to everyone but its owner. No bits (Windows) counts as closed. */
export const isOwnerOnly = (mode: Option.Option<number>): boolean =>
  Option.match(mode, { onNone: () => true, onSome: (bits) => (bits & 0o077) === 0 })

/** The permission bits as `chmod` writes them: 755. */
export const modeText = (mode: Option.Option<number>): string =>
  Option.match(mode, { onNone: () => "none", onSome: (bits) => bits.toString(8) })

const failed = (message: string) => new CredentialError({ kind: "providerFailed", message })

/**
 * Makes `dir` and any parent it lacks owner-only, or checks that one that
 * is there already is a directory only its owner can read. A resumed
 * session finds its blocks' directories there.
 */
export const prepareStateDir = (dir: string): Effect.Effect<void, CredentialError, FileSystem> =>
  Effect.gen(function* () {
    const files = yield* FileSystem
    yield* files
      .mkdir(dir, { recursive: true, mode: STATE_DIR_MODE })
      .pipe(Effect.mapError(() => failed(`The credential state folder ${dir} could not be made.`)))
    const stat = yield* files
      .stat(dir)
      .pipe(Effect.mapError(() => failed(`The credential state folder ${dir} is not there.`)))
    if (!stat.isDirectory)
      return yield* failed(`The credential state folder ${dir} is a file, not a folder.`)
    if (!isOwnerOnly(stat.mode))
      return yield* failed(
        `Others can read the credential state folder ${dir} (mode ${modeText(stat.mode)}), so no credential is kept in it. Run chmod 700 on it, then check again.`,
      )
  })
