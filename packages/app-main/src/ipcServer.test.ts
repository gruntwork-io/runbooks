import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer, Queue, type Scope, Stream } from "effect"
import { type Rpc, RpcClient, type RpcMessage, RpcSerialization, type RpcServer } from "effect/rpc"
import {
  type EngineClient,
  EngineProtocol,
  RunbookUnreadable,
  type WatchMode,
} from "@runbooks/core/protocol"
import { VcsCredentials } from "@runbooks/core/services/VcsCredentials"
import { ChildProcessSpawnerLive } from "@runbooks/platform-node/layers/ChildProcessSpawner"
import { GitCliClientLive } from "@runbooks/platform-node/layers/GitCliClient"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { ProcessEnvironmentLive } from "@runbooks/platform-node/layers/ProcessEnvironment"
import { FROM_PAGE, MAX_PAGE_MESSAGE, TO_PAGE } from "./bridge.ts"
import { appEngine } from "./engine.ts"
import { DROPPED, isAppPage, makeIpcServerProtocol, MAX_QUEUED, servePage } from "./ipcServer.ts"
import {
  type Launch,
  type Launches,
  makeLaterLaunches,
  MAX_WAITING_LAUNCHES,
  serveLaunch,
  waitToOpen,
} from "./launch.ts"

// The server end over stand-ins for the window's web contents and its
// frames, serving the app's real engine over a temporary user data folder.
// A page is a listener on what main sends, and an emitter of what it sends.

/** The page main loads in a build (pageScheme.ts). */
const PAGE = new URL("runbooks-app://window/index.html")

/** A frame, as `WebFrameMain` describes one. */
interface FakeFrame {
  url: string
  parent: FakeFrame | null
  detached: boolean
  processId: number
  routingId: number
}

const mainFrame = (routingId = 1, url = PAGE.href): FakeFrame => ({
  url,
  parent: null,
  detached: false,
  processId: 7,
  routingId,
})

/** The window's web contents: what the server reads and calls of `WebContents`. */
class FakeContents extends EventEmitter {
  readonly ipc = new EventEmitter()
  mainFrame = mainFrame()
  destroyed = false
  type = "window"
  /** What the page now shown hears from main. */
  page: ((text: string) => void) | undefined
  isDestroyed() {
    return this.destroyed
  }
  getType() {
    return this.type
  }
  send(channel: string, text: string) {
    if (channel === TO_PAGE) this.page?.(text)
  }
  /** Shows a new document in the main frame, as a load or a reload commits one. */
  navigate(frame: FakeFrame = mainFrame(this.mainFrame.routingId)) {
    this.mainFrame = frame
    this.page = undefined
    this.emit("did-navigate")
  }
  /** Sends `message` to main as `frame` would, from `sender`. */
  fromFrame(frame: FakeFrame | null, message: unknown, sender: unknown = this) {
    this.ipc.emit(FROM_PAGE, { sender, senderFrame: frame }, message)
  }
}

let folder: string
let contents: FakeContents
let logged: string[]
beforeEach(() => {
  folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "runbooks-ipc-server-")))
  contents = new FakeContents()
  logged = []
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

/** What the server took from the page and tried to send it, by client id. */
interface Seen {
  readonly taken: Array<[number, RpcMessage.FromClientEncoded]>
  readonly sent: Array<[number, RpcMessage.FromServerEncoded]>
}

/**
 * Runs `use` with the server serving the engine over the stand-in contents,
 * which have not loaded a page yet. The protocol is wrapped to see what the
 * server takes and sends.
 */
const withServer = <A>(use: (seen: Seen) => Effect.Effect<A, unknown, Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const protocol = yield* makeIpcServerProtocol({
          contents,
          page: PAGE,
          log: (line) => logged.push(line),
        })
        const seen: Seen = { taken: [], sent: [] }
        const watched: RpcServer.Protocol["Service"] = {
          ...protocol,
          run: (receive) =>
            protocol.run((client, message) => {
              seen.taken.push([client, message])
              return receive(client, message)
            }),
          send: (client, response, transferables) => {
            seen.sent.push([client, response])
            return protocol.send(client, response, transferables)
          },
        }
        yield* servePage(watched).pipe(
          Effect.provide(
            appEngine({
              userData: path.join(folder, "user data"),
              appVersion: "0.31.0",
              processEnvironment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
            }),
          ),
          Effect.forkScoped,
        )
        return yield* use(seen)
      }),
    ),
  )

/** Runs `use` with the server end alone, which no server reads from. */
const withProtocol = <A>(
  use: (protocol: RpcServer.Protocol["Service"]) => Effect.Effect<A, unknown, Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        makeIpcServerProtocol({ contents, page: PAGE, log: (line) => logged.push(line) }),
        use,
      ),
    ),
  )

/** The server's answer to `requestId`, as it sends one. */
const exitOf = (requestId: string, value: string): RpcMessage.FromServerEncoded => ({
  _tag: "Exit",
  requestId,
  exit: { _tag: "Success", value },
})

const { codecFor } = RpcSerialization.json

/** A client on the page the contents show now, as the renderer makes one. */
const pageClient = Effect.fnUntraced(function* () {
  const page = contents
  const frame = page.mainFrame
  const receiver =
    yield* Deferred.make<(message: RpcMessage.FromServerEncoded) => Effect.Effect<void>>()
  page.page = (text) => {
    Effect.runFork(Effect.flatMap(Deferred.await(receiver), (deliver) => deliver(JSON.parse(text))))
  }
  const protocol = RpcClient.Protocol.of({
    run: (_client, receive) => Effect.andThen(Deferred.succeed(receiver, receive), Effect.never),
    send: (_client, request) => Effect.sync(() => page.fromFrame(frame, JSON.stringify(request))),
    supportsAck: true,
    supportsTransferables: false,
    codecFor,
  })
  const client: EngineClient = yield* RpcClient.make(EngineProtocol).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  )
  return client
})

/** A page that sends raw messages, and keeps what main sends it. */
const rawPage = () => {
  const frame = contents.mainFrame
  const heard: RpcMessage.FromServerEncoded[] = []
  contents.page = (text) => heard.push(JSON.parse(text))
  return {
    heard,
    send: (message: object) => contents.fromFrame(frame, JSON.stringify(message)),
    frame,
  }
}

const request = (id: string, tag: string, payload: unknown = null) => ({
  _tag: "Request",
  id,
  tag,
  payload,
  headers: [],
})

/** Waits until `ready` holds, for at most two seconds. */
const until = (ready: () => boolean) =>
  Effect.promise(async () => {
    for (let waited = 0; !ready(); waited += 5) {
      if (waited > 2000) throw new Error("It did not happen within two seconds.")
      await Bun.sleep(5)
    }
  })

/** Lets every fiber that can run, run. */
const settle = Effect.promise(() => Bun.sleep(50))

/** Whether the server answered `id`, and not with a failure. */
const answered = (heard: RpcMessage.FromServerEncoded[], id: string) =>
  heard.some(
    (message) =>
      message._tag === "Exit" && message.requestId === id && message.exit._tag === "Success",
  )

const chunks = (heard: RpcMessage.FromServerEncoded[], id: string) =>
  heard.filter((message) => message._tag === "Chunk" && message.requestId === id)

const FIXTURE = path.resolve(import.meta.dirname, "../../../blocks/command/testdata/end-to-end")

describe("the engine over IPC", () => {
  it("answers the app's page, whose commands are a person's", async () => {
    const result = await withServer(() =>
      Effect.gen(function* () {
        contents.navigate()
        const client = yield* pageClient()
        const settings = yield* client.GetSettings()
        // Only a person may change settings or trust a runbook.
        const changed = yield* client.ChangeSettings({ changes: { theme: "dark" } })
        const opened = yield* client.OpenSession({ path: path.join(FIXTURE, "runbook.mdx") })
        if (opened._tag !== "Opened") throw new Error("The fixture did not open.")
        const trusted = yield* client.TrustSession({
          session: opened.session.session,
          hash: opened.session.trust.hash,
        })
        return { file: settings.file, changed: changed._tag, trusted: trusted._tag }
      }),
    )
    expect(result).toEqual({
      file: path.join(folder, "user data", "settings.json"),
      changed: "Changed",
      trusted: "Trusted",
    })
  })

  const refused: Array<[string, () => void]> = [
    [
      "a subframe of the app's page",
      () =>
        contents.fromFrame(
          { ...mainFrame(2), parent: contents.mainFrame },
          JSON.stringify(request("r", "GetSettings")),
        ),
    ],
    [
      "a frame that has gone",
      () => contents.fromFrame(null, JSON.stringify(request("r", "GetSettings"))),
    ],
    [
      "the main frame being replaced",
      () =>
        contents.fromFrame(
          { ...contents.mainFrame, detached: true },
          JSON.stringify(request("r", "GetSettings")),
        ),
    ],
    [
      "a main frame the window no longer shows",
      () => contents.fromFrame(mainFrame(9), JSON.stringify(request("r", "GetSettings"))),
    ],
    [
      "another page in the app's window",
      () => {
        contents.mainFrame = mainFrame(1, "https://example.com/")
        contents.fromFrame(contents.mainFrame, JSON.stringify(request("r", "GetSettings")))
      },
    ],
    [
      "the app's page with a query",
      () => {
        contents.mainFrame = mainFrame(1, `${PAGE.href}?from=elsewhere`)
        contents.fromFrame(contents.mainFrame, JSON.stringify(request("r", "GetSettings")))
      },
    ],
    [
      "another file in the app's folder",
      () => {
        contents.mainFrame = mainFrame(1, new URL("other.html", PAGE).href)
        contents.fromFrame(contents.mainFrame, JSON.stringify(request("r", "GetSettings")))
      },
    ],
    [
      "other web contents",
      () => contents.fromFrame(contents.mainFrame, JSON.stringify(request("r", "GetSettings")), {}),
    ],
    [
      "web contents that are not a window",
      () => {
        contents.type = "webview"
        contents.fromFrame(contents.mainFrame, JSON.stringify(request("r", "GetSettings")))
      },
    ],
  ]

  it.each(refused)("hears nothing from %s, and the server sees nothing", async (_name, send) => {
    const { heard, taken } = await withServer((seen) =>
      Effect.gen(function* () {
        contents.navigate()
        const page = rawPage()
        send()
        yield* settle
        return { heard: [...page.heard], taken: [...seen.taken] }
      }),
    )
    expect(taken).toEqual([])
    expect(heard).toEqual([])
    expect(logged).toEqual([DROPPED.refused])
  })

  it("hears the app's page at any fragment", async () => {
    const heard = await withServer(() =>
      Effect.gen(function* () {
        contents.navigate(mainFrame(1, `${PAGE.href}#/settings`))
        const page = rawPage()
        page.send(request("r", "GetSettings"))
        yield* until(() => answered(page.heard, "r"))
        return page.heard
      }),
    )
    expect(answered(heard, "r")).toBe(true)
  })

  it("drops what is not a request, an ack or an interrupt, or is too long, unread", async () => {
    const taken = await withServer((seen) =>
      Effect.gen(function* () {
        contents.navigate()
        const page = rawPage()
        const garbage: unknown[] = [
          42,
          { _tag: "Request" },
          "not JSON",
          JSON.stringify([request("a", "GetSettings")]),
          JSON.stringify({ _tag: "Eof" }),
          JSON.stringify({ _tag: "Ping" }),
          JSON.stringify({ ...request("b", "GetSettings"), tag: 3 }),
          JSON.stringify({ ...request("c", "GetSettings"), headers: [["only one"]] }),
          // Whitespace JSON.parse would skip, past the length main reads.
          JSON.stringify(request("d", "GetSettings")) + " ".repeat(MAX_PAGE_MESSAGE),
        ]
        for (const message of garbage) contents.fromFrame(page.frame, message)
        yield* settle
        expect(page.heard).toEqual([])
        page.send(request("e", "GetSettings"))
        yield* until(() => answered(page.heard, "e"))
        return seen.taken.map(([, message]) =>
          message._tag === "Request" ? message.id : message._tag,
        )
      }),
    )
    expect(taken).toEqual(["e"])
    expect(logged).toEqual([DROPPED.malformed])
  })

  it("gives each page load a client of its own, which nothing the page sends names", async () => {
    const clients = await withServer((seen) =>
      Effect.gen(function* () {
        contents.navigate()
        const first = rawPage()
        first.send({ ...request("r", "GetSettings"), clientId: 41, client: 41 })
        yield* until(() => answered(first.heard, "r"))
        contents.navigate()
        const second = rawPage()
        second.send({ ...request("r", "GetSettings"), clientId: 0, client: 0 })
        yield* until(() => answered(second.heard, "r"))
        return seen.taken.map(([client]) => client)
      }),
    )
    expect(clients).toEqual([0, 1])
  })

  it("ends the old page's streams when the page reloads, and serves the new page", async () => {
    const result = await withServer((seen) =>
      Effect.gen(function* () {
        contents.navigate()
        const old = rawPage()
        old.send(request("w", "WatchSettings"))
        yield* until(() => chunks(old.heard, "w").length === 1)
        old.send({ _tag: "Ack", requestId: "w" })
        yield* settle

        contents.navigate()
        const sentBefore = seen.sent.length
        const client = yield* pageClient()
        yield* client.ChangeSettings({ changes: { theme: "dark" } })
        const watched = yield* client.WatchSettings().pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.map((views) => views[0]?.settings.theme),
        )
        yield* settle
        return {
          watched,
          toOld: seen.sent.slice(sentBefore).filter(([id]) => id === 0),
          oldHeard: chunks(old.heard, "w").length,
        }
      }),
    )
    expect(result.watched).toBe("dark")
    expect(result.toOld).toEqual([])
    expect(result.oldHeard).toBe(1)
  })

  it("sends a reloaded page nothing the server answers for the page before it", async () => {
    // Each page's client numbers its requests from 0, so an answer to the
    // old page that the server sends after the reload has the id of the new
    // page's first request.
    const heard = await withProtocol((protocol) =>
      Effect.gen(function* () {
        contents.navigate()
        contents.navigate()
        const page = rawPage()
        yield* protocol.send(0, exitOf("0", "the old page's settings"))
        yield* protocol.send(1, exitOf("0", "the new page's settings"))
        return page.heard
      }),
    )
    expect(heard).toEqual([exitOf("0", "the new page's settings")])
  })

  for (const [when, gone] of [
    ["its renderer process goes", () => contents.emit("render-process-gone")],
    [
      "the window's contents are destroyed",
      () => {
        contents.destroyed = true
        contents.emit("destroyed")
      },
    ],
  ] as const)
    it(`tells the server the page's client has ended when ${when}`, async () => {
      const result = await withProtocol((protocol) =>
        Effect.gen(function* () {
          contents.navigate()
          gone()
          const ended = yield* Queue.take(protocol.disconnects).pipe(Effect.timeout("1 second"))
          return { ended, clients: [...(yield* protocol.clientIds)] }
        }),
      )
      expect(result).toEqual({ ended: 0, clients: [] })
    })

  it("sends a stream's next chunk only after the page acks the last", async () => {
    const result = await withServer(() =>
      Effect.gen(function* () {
        contents.navigate()
        const page = rawPage()
        page.send(request("w", "WatchSettings"))
        yield* until(() => chunks(page.heard, "w").length === 1)
        page.send(request("c1", "ChangeSettings", { changes: { theme: "dark" } }))
        page.send(request("c2", "ChangeSettings", { changes: { theme: "light" } }))
        yield* until(() => answered(page.heard, "c1") && answered(page.heard, "c2"))
        yield* settle
        const beforeAck = chunks(page.heard, "w").length
        page.send({ _tag: "Ack", requestId: "w" })
        yield* until(() => chunks(page.heard, "w").length === 2)
        return beforeAck
      }),
    )
    expect(result).toBe(1)
  })

  it("ends the connection of a page that floods main, and serves its next load", async () => {
    const result = await withServer((seen) =>
      Effect.gen(function* () {
        contents.navigate()
        const page = rawPage()
        for (let sent = 0; sent <= MAX_QUEUED; sent++)
          page.send({ _tag: "Ack", requestId: `a${sent}` })
        page.send(request("late", "GetSettings"))
        yield* settle
        const takenFromFlood = seen.taken.length
        contents.navigate()
        const next = rawPage()
        next.send(request("r", "GetSettings"))
        yield* until(() => answered(next.heard, "r"))
        return { takenFromFlood, late: answered(page.heard, "late") }
      }),
    )
    expect(result).toEqual({ takenFromFlood: 0, late: false })
    expect(logged).toEqual([DROPPED.flooded])
  })

  it("logs what it drops once per page load and kind, with nothing of the message", async () => {
    await withServer(() =>
      Effect.gen(function* () {
        contents.navigate()
        const page = rawPage()
        for (let sent = 0; sent < 3; sent++) {
          contents.fromFrame(null, JSON.stringify(request("secret-value", "GetSettings")))
          contents.fromFrame(page.frame, "secret-value")
        }
        contents.navigate()
        contents.fromFrame(null, "secret-value")
        yield* settle
      }),
    )
    expect(logged).toEqual([DROPPED.refused, DROPPED.malformed, DROPPED.refused])
    expect(logged.join("\n")).not.toContain("secret")
    expect(logged.join("\n")).not.toContain("file:")
  })

  it("sends nothing once the window's contents have gone", async () => {
    const heard = await withServer(() =>
      Effect.gen(function* () {
        contents.navigate()
        const page = rawPage()
        page.send(request("w", "WatchSettings"))
        yield* until(() => chunks(page.heard, "w").length === 1)
        contents.destroyed = true
        contents.emit("destroyed")
        page.send({ _tag: "Ack", requestId: "w" })
        page.send(request("r", "GetSettings"))
        yield* settle
        return page.heard.length
      }),
    )
    expect(heard).toBe(1)
  })

  it("stops listening when its scope closes", async () => {
    await withServer(() => Effect.sync(() => contents.navigate()))
    expect(contents.ipc.listenerCount(FROM_PAGE)).toBe(0)
    expect(contents.listenerCount("did-navigate")).toBe(0)
  })
})

/** Credentials for no host. A source the parser refuses gets no further than the hosts. */
const unused = (name: string) => () => Effect.die(`${name} is not used by a refused source`)
const noCredentials = Layer.succeed(VcsCredentials, {
  enumerateGitHubHosts: () => Effect.succeed({ configHosts: [], defaultHost: "github.com" }),
  detectProvider: unused("detectProvider"),
  tokenForHost: unused("tokenForHost"),
  detectGitHubEnv: unused("detectGitHubEnv"),
  detectGitHubCli: unused("detectGitHubCli"),
  detectGitLabEnv: unused("detectGitLabEnv"),
  detectGitLabCli: unused("detectGitLabCli"),
  validateDirect: unused("validateDirect"),
  enumerateGitLabHosts: unused("enumerateGitLabHosts"),
  validateViaCli: unused("validateViaCli"),
  cliStatus: unused("cliStatus"),
  invalidateCache: unused("invalidateCache"),
  markTransportDegraded: unused("markTransportDegraded"),
})

/**
 * The engine a launch's runbook opens on, over the test's user data folder,
 * with what cloning takes. `openSession`, given last, takes the place of the
 * engine's own handler.
 */
const launchEngine = (openSession?: Layer.Layer<Rpc.Handler<"OpenSession">>) => {
  const engine = Layer.mergeAll(
    appEngine({
      userData: path.join(folder, "user data"),
      appVersion: "0.31.0",
      processEnvironment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    }),
    NodeFileSystemLive,
    GitCliClientLive.pipe(Layer.provide(ChildProcessSpawnerLive)),
    ChildProcessSpawnerLive,
    ProcessEnvironmentLive,
    noCredentials,
  )
  return openSession === undefined ? engine : Layer.merge(engine, openSession)
}

/** An `OpenSession` that keeps each payload main sends in `asked`, and opens nothing. */
const recordingOpens = (asked: unknown[]) =>
  EngineProtocol.toLayerHandler("OpenSession", (payload) => {
    asked.push(payload)
    return Effect.fail(new RunbookUnreadable({ path: payload.path, message: "recorded" }))
  })

/**
 * The launches main serves: `first`, those put in `later`, and each time it
 * shows one, in the watch mode the app's command line asked for.
 */
const launchesOf = (
  first: Launch | undefined,
  later: Queue.Dequeue<Launch>,
  shown: string[] = [],
  watch: WatchMode = "notice",
): Launches => ({
  first,
  later,
  watch,
  clones: path.join(folder, "user data", "v0", "clones"),
  log: (line) => logged.push(line),
  show: () => shown.push("shown"),
})

describe("a runbook the launch names", () => {
  /**
   * Has the page send `ListSessions` before main serves anything, then serves
   * the launch of `argument` and returns what the page heard.
   */
  const listFirst = (
    argument: string,
    openSession?: Layer.Layer<Rpc.Handler<"OpenSession">>,
    watch?: WatchMode,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* makeIpcServerProtocol({
            contents,
            page: PAGE,
            log: (line) => logged.push(line),
          })
          contents.navigate()
          const client = yield* pageClient()
          const listed = yield* Effect.forkScoped(client.ListSessions())
          yield* settle
          const later = yield* makeLaterLaunches()
          yield* serveLaunch(
            protocol,
            launchesOf({ argument, startedIn: folder }, later, [], watch),
          ).pipe(Effect.provide(launchEngine(openSession)), Effect.forkScoped)
          return yield* Fiber.join(listed)
        }),
      ),
    )

  it("is open when a page that asked before the open was done hears back", async () => {
    const sessions = await listFirst(FIXTURE)
    expect(sessions.map(({ path: file }) => file)).toEqual([path.join(FIXTURE, "runbook.mdx")])
    expect(logged).toEqual([])
  })

  it.each(["notice", "runbook", "runbookAndFiles"] as const)(
    "opens in the watch mode the app's command line asks for: %s",
    async (watch) => {
      const asked: unknown[] = []
      await listFirst(FIXTURE, recordingOpens(asked), watch)
      expect(asked).toEqual([{ path: path.join(FIXTURE, "runbook.mdx"), watch }])
    },
  )

  it("is not open when the engine refuses it, and main logs each error with its line", async () => {
    const runbook = path.join(folder, "refused.mdx")
    writeFileSync(runbook, "# Refused\n\n[click](javascript:alert(1))\n")
    const sessions = await listFirst(runbook)
    expect(sessions).toEqual([])
    expect(logged[0]).toBe(`Runbooks could not open ${runbook}:`)
    expect(logged[1]).toStartWith(`  ${runbook}:3:1: `)
    expect(logged[1]).toContain("`javascript:` URLs")
  })

  it("is not open when the engine fails opening it, and main says so and serves the page", async () => {
    // As a runbook nested deep enough to overflow the engine's stack does.
    const dies = EngineProtocol.toLayerHandler("OpenSession", () =>
      Effect.die(new RangeError("Maximum call stack size exceeded")),
    )
    const sessions = await listFirst(FIXTURE, dies)
    expect(sessions).toEqual([])
    expect(logged).toEqual([
      `Runbooks could not open ${FIXTURE}: the engine failed: RangeError: Maximum call stack size exceeded`,
    ])
  })

  it("is not open when its URL can't be read, and main says why in one line, without the URL's credentials", async () => {
    // Built at runtime so secret scanners don't flag the fixture.
    const password = ["hunter", "2"].join("")
    const sessions = await listFirst(`https://someone:${password}@bitbucket.org/o/r/src/main/rb`)
    expect(sessions).toEqual([])
    expect(logged).toEqual([
      "Runbooks could not open https://bitbucket.org/o/r/src/main/rb: unsupported URL format: use a GitHub or GitLab link to a runbook directory or runbook.mdx, or a source like github.com/org/repo//path/to/runbook?ref=main",
    ])
  })

  it("names no token the engine's failure holds", async () => {
    // Assembled at runtime so no credential-shaped literal sits in the source.
    const token = "ghp_" + "a".repeat(36)
    const dies = EngineProtocol.toLayerHandler("OpenSession", () =>
      Effect.die(new Error(`the engine read ${token}`)),
    )
    const sessions = await listFirst(FIXTURE, dies)
    expect(sessions).toEqual([])
    expect(logged).toEqual([
      `Runbooks could not open ${FIXTURE}: the engine failed: Error: the engine read [REDACTED]`,
    ])
  })

  it("is not open when nothing is at its path, and main says so", async () => {
    const sessions = await listFirst("missing")
    expect(sessions).toEqual([])
    expect(logged).toEqual([
      `Runbooks could not open ${path.join(folder, "missing")}: there is no file or folder there.`,
    ])
  })
})

describe("a runbook a later launch names", () => {
  /**
   * Serves the launch of `first`, puts each of `later` in line, waits until
   * `done` holds, and returns the runbooks of the sessions the page lists and
   * each time main showed one.
   */
  const serveLater = (
    first: string | undefined,
    later: ReadonlyArray<Launch>,
    done: (shown: ReadonlyArray<string>) => boolean,
    openSession?: Layer.Layer<Rpc.Handler<"OpenSession">>,
    watch?: WatchMode,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* makeIpcServerProtocol({
            contents,
            page: PAGE,
            log: (line) => logged.push(line),
          })
          contents.navigate()
          const client = yield* pageClient()
          const waiting = yield* makeLaterLaunches()
          const shown: string[] = []
          const launches = launchesOf(
            first === undefined ? undefined : { argument: first, startedIn: folder },
            waiting,
            shown,
            watch,
          )
          for (const launch of later) waitToOpen(waiting, launch, launches.log)
          yield* serveLaunch(protocol, launches).pipe(
            Effect.provide(launchEngine(openSession)),
            Effect.forkScoped,
          )
          yield* until(() => done(shown))
          yield* settle
          const sessions = yield* client.ListSessions()
          return { sessions: sessions.map(({ path: file }) => file), shown }
        }),
      ),
    )

  it("opens after the first launch's, from the folder its launch started in, and main shows it", async () => {
    const started = path.join(folder, "elsewhere")
    mkdirSync(path.join(started, "later"), { recursive: true })
    writeFileSync(path.join(started, "later", "runbook.mdx"), "# Later\n")
    const { sessions, shown } = await serveLater(
      FIXTURE,
      [{ argument: "later", startedIn: started }],
      (seen) => seen.length === 1,
    )
    expect(sessions).toEqual([
      path.join(FIXTURE, "runbook.mdx"),
      path.join(started, "later", "runbook.mdx"),
    ])
    expect(shown).toEqual(["shown"])
    expect(logged).toEqual([])
  })

  it("opens in the watch mode the app's own command line asked for", async () => {
    const one = path.join(folder, "one.mdx")
    writeFileSync(one, "# One\n")
    const asked: unknown[] = []
    await serveLater(
      FIXTURE,
      [{ argument: one, startedIn: folder }],
      () => logged.length === 2,
      recordingOpens(asked),
      "runbook",
    )
    expect(asked).toEqual([
      { path: path.join(FIXTURE, "runbook.mdx"), watch: "runbook" },
      { path: one, watch: "runbook" },
    ])
  })

  it("opens one at a time, and main shows each", async () => {
    const one = path.join(folder, "one.mdx")
    const two = path.join(folder, "two.mdx")
    writeFileSync(one, "# One\n")
    writeFileSync(two, "# Two\n")
    const { sessions, shown } = await serveLater(
      undefined,
      [
        { argument: one, startedIn: folder },
        { argument: two, startedIn: folder },
      ],
      (seen) => seen.length === 2,
    )
    expect(sessions).toEqual([one, two])
    expect(shown).toEqual(["shown", "shown"])
  })

  it("is not shown when it does not open, and main says why", async () => {
    const { sessions, shown } = await serveLater(
      FIXTURE,
      [{ argument: "missing", startedIn: folder }],
      () => logged.length === 1,
    )
    expect(sessions).toEqual([path.join(FIXTURE, "runbook.mdx")])
    expect(shown).toEqual([])
    expect(logged).toEqual([
      `Runbooks could not open ${path.join(folder, "missing")}: there is no file or folder there.`,
    ])
  })

  it("is refused past the launches already waiting, and main says so without its credentials", async () => {
    // Built at runtime so secret scanners don't flag the fixture.
    const password = ["hunter", "2"].join("")
    const waiting = await Effect.runPromise(makeLaterLaunches())
    const launch = {
      argument: `https://someone:${password}@github.com/acme/runbooks/tree/main/walk`,
      startedIn: folder,
    }
    for (let index = 0; index <= MAX_WAITING_LAUNCHES; index += 1)
      waitToOpen(waiting, launch, (line) => logged.push(line))
    expect(logged).toEqual([
      `Runbooks could not open https://github.com/acme/runbooks/tree/main/walk: ${MAX_WAITING_LAUNCHES} launches already wait to open. Launch it again once they have.`,
    ])
    expect(await Effect.runPromise(Queue.size(waiting))).toBe(MAX_WAITING_LAUNCHES)
  })
})

describe("isAppPage", () => {
  const event = (frame: FakeFrame | null, sender: unknown) => ({ sender, senderFrame: frame })
  it("accepts the main frame the window shows, at the app's page", () => {
    const shown = new FakeContents()
    expect(isAppPage(event(shown.mainFrame, shown), shown, PAGE)).toBe(true)
  })
  it("refuses a dev server's page in a build, and the build's page under a dev server", () => {
    const shown = new FakeContents()
    shown.mainFrame = mainFrame(1, "http://localhost:5173/")
    expect(isAppPage(event(shown.mainFrame, shown), shown, PAGE)).toBe(false)
    expect(isAppPage(event(shown.mainFrame, shown), shown, new URL("http://localhost:5173"))).toBe(
      true,
    )
  })
})
