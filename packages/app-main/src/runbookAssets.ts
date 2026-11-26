/**
 * A runbook's assets: the files in the `assets/` folder beside its runbook
 * file, which the window shows as images, audio and video. Main serves them
 * on the window's session at `runbook-asset://<host>/<path in assets/>`.
 *
 * - The host is the id of the engine's session that has the runbook open.
 *   The engine makes each id with `crypto.randomUUID()`, and a lowercase
 *   UUID parses as a host as written and never as an IP address: it has no
 *   dot, and holds a `-`. Main asks the engine which runbook the session has
 *   open. A host that is not such an id, or names no open session, gets
 *   nothing.
 * - The path guard: the URL's path is percent-decoded before the check, so
 *   the path checked is the path served, and must name a regular file inside
 *   assets/ once every symbolic link is followed (pathGuard.ts). Nothing is
 *   served when assets/ is itself a symbolic link: `assets -> .` would make
 *   the whole runbook folder assets/.
 */
import path from "node:path"
import { Effect, Option } from "effect"
import type { EngineClient } from "@runbooks/core/protocol"
import { getContentType } from "@runbooks/core/domain/workspace/file"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { fileResponse } from "./byteRange.ts"
import { notFound, servedFile } from "./pathGuard.ts"

/** The scheme main serves a runbook's assets from. */
export const ASSET_SCHEME = "runbook-asset"

/** The folder beside a runbook file that its assets are in. */
const ASSETS_FOLDER = "assets"

/** A session id as the engine makes it, and so a host: a lowercase UUID. */
const SESSION_HOST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The runbook file of the open session whose id is `host`, or undefined when none has that id. */
export type SessionRunbook = (host: string) => Effect.Effect<string | undefined>

/** The runbook file of each session the engine `client` talks to has open, by its id. */
export const sessionRunbook =
  (client: EngineClient): SessionRunbook =>
  (host) =>
    client.ListSessions().pipe(
      Effect.map((sessions) => sessions.find((session) => session.session === host)?.path),
      Effect.orElseSucceed(() => undefined),
    )

/**
 * The file `requestUrl` names in the assets/ folder of the runbook its host's
 * session has open (`runbookOf`), or undefined when it names none or the
 * path guard refuses it.
 */
export const runbookAsset = (
  requestUrl: string,
  runbookOf: SessionRunbook,
): Effect.Effect<string | undefined, never, FileSystem> =>
  Effect.gen(function* () {
    const url = URL.parse(requestUrl)
    if (url === null || url.protocol !== `${ASSET_SCHEME}:` || !SESSION_HOST.test(url.hostname))
      return undefined
    const runbook = yield* runbookOf(url.hostname)
    if (runbook === undefined) return undefined
    const assets = path.join(path.dirname(runbook), ASSETS_FOLDER)
    const linked = yield* Effect.option((yield* FileSystem).isSymbolicLink(assets))
    if (Option.isNone(linked) || linked.value) return undefined
    return yield* servedFile(url, assets)
  })

/**
 * The answer to `request` for a runbook asset: the file, or a byte range of
 * it for a GET with a Range header (byteRange.ts), or a 404 for a file the
 * guard refuses or that is not there.
 */
export const serveRunbookAsset = (
  request: Request,
  runbookOf: SessionRunbook,
): Effect.Effect<Response, never, FileSystem> =>
  Effect.gen(function* () {
    const file = yield* runbookAsset(request.url, runbookOf)
    if (file === undefined) return notFound()
    const stat = yield* Effect.option((yield* FileSystem).stat(file))
    if (Option.isNone(stat) || !stat.value.isFile) return notFound()
    const range = request.method === "GET" ? request.headers.get("range") : null
    return yield* fileResponse(file, stat.value.size, getContentType(file), range)
  })
